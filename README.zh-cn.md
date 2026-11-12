# es-modbus

[English](./README.md)

一个小巧的 Node.js Modbus 客户端与服务端，ES 模块，没有运行时依赖。

- **传输方式：** Modbus TCP、串口上的 Modbus RTU，以及 RTU over TCP。
- **功能码：** 1、2、3、4、5、6、15、16，以及异常响应。
- **客户端：** 基于 Promise 的读写、按请求计算的超时、发送节奏控制、指数退避的自动重连，
  以及 TCP 上的死链检测。
- **服务端：** 一个实例可以服务多个单元号；数据留在你自己的 `handler` 里。

## 安装

```sh
pnpm add es-modbus
```

需要 Node.js 20.11 或更高版本。串口支持以预编译的原生插件提供，覆盖 Windows、macOS、
Linux（glibc 与 musl）和 Android；它只在首次使用串口时加载，所以 TCP 在任何平台都能用。

## 客户端

```js
import { Modbus_Client } from 'es-modbus';

// Modbus TCP
const client = new Modbus_Client({ tcp: '192.168.1.10:502', timeout: 1000 });

// 从单元 1 读 40001 起的 2 个保持寄存器
const data = await client.read('40001,2', 1);
console.log(data.readUInt16BE(0), data.readUInt16BE(2));

// 写一个保持寄存器，以及 16 个线圈
await client.write('40010', 1234, 1);
await client.write('00001,16', Buffer.from([0xff, 0x00]), 1);

await client.disconnect();
```

`tcp`、`rtu_over_tcp`、`serial` 中恰好一个选定传输方式。前两者取 `host:port` 字符串（端口默认为
`502`，IPv6 主机写作 `[::1]:502`），`serial` 取串口设备路径：

```js
// RTU over TCP，例如串口转以太网网关
const gateway = new Modbus_Client({ rtu_over_tcp: '192.168.1.20:4001' });

// 串口上的 RTU
const serial = new Modbus_Client({ serial: 'COM3', baud_rate: 19200, parity: 'even' });
```

### 范围

范围是起始地址加长度，有两种写法：

- **Modicon 字符串**，`"<地址>[,<长度>]"`，5 位或 6 位，首位数字选择数据表。点号从 1 开始，
  除非创建客户端时指定 `modicon_zero_based: true`。

  | 首位数字 | 数据表     | 读功能码 | 写功能码 |
  | -------- | ---------- | -------- | -------- |
  | `0`      | 线圈       | 1        | 5、15    |
  | `1`      | 离散输入   | 2        | —        |
  | `3`      | 输入寄存器 | 4        | —        |
  | `4`      | 保持寄存器 | 3        | 6、16    |

- **结构化 PDU 范围**，`[func_code, pdu_addr, length]` 或 `{ func_code, pdu_addr, length }`，
  其中 `pdu_addr` 是线上传输的从 0 开始的地址。

`"40257,2"`、`"400257,2"` 和 `[3, 256, 2]` 指的是同样的两个保持寄存器。

### 结果与错误

- `read(range, unit_id = 1)` 以原始负载 `Buffer` 兑现：寄存器为大端字，线圈按低位在前打包。
  解码由调用方完成。
- `write(range, value, unit_id = 1)` 在响应回显与请求一致时以 `true` 兑现。`value` 对单个线圈是
  `boolean`，对单个寄存器是 `0..65535` 的整数，多个点时是 `Buffer`。
- 两者都以 `Error` 拒绝：`transaction 0x<id> timeout`、异常响应时的 `response error: <code>`、
  `connection lost` 或 `queue overflow`。
- 参数无效（范围、长度、单元号、值）时同步抛出。

### 主要选项

| 选项             | 默认值  | 含义                                                   |
| ---------------- | ------- | ------------------------------------------------------ |
| `tcp`、`rtu_over_tcp`、`serial` | — | 传输方式及其目标；必须恰好给出一个。 |
| `timeout`        | `1000`  | 每个请求的响应超时，毫秒。                             |
| `delay`          | `20`    | 帧之间的最小间隔，毫秒。                               |
| `reconnect_time` | `10000` | 初始重连延迟，毫秒；`> 0` 时还会立即连接。             |
| `reconnect_max`  | `60000` | 重连延迟的上限，毫秒。                                 |
| `max_timeouts`   | `3`     | TCP：连续超时这么多次后关闭连接；`0` 表示关闭此功能。  |
| `baud_rate`、`parity`、`data_bits`、`stop_bits` | `9600`、`'none'`、`8`、`1` | 串口参数。 |

不适用于所选传输方式的选项，例如 TCP 客户端上的 `baud_rate`，会在构造时抛错。

事件：`connect`、`disconnect`、`error`、`timeout`、`send`、`receive`、`data`、`data_error`。

## 服务端

服务端不保存数据：每个请求都调用你的 `handler` 中的函数，传入 PDU 地址（从 0 开始）和单元号。

```js
import { Modbus_Server, Modbus_Exception } from 'es-modbus';

const holding = new Uint16Array(100);

const handler = {
	get_coil: (addr, unit_id) => false,
	get_input_register: (addr, unit_id) => 0,
	get_holding_register: (addr, unit_id) => holding[addr] ?? 0,
	set_coil: (addr, value, unit_id) => {},
	set_holding_register(addr, value, unit_id) {
		if (addr >= holding.length) throw new Modbus_Exception(0x02);
		holding[addr] = value;
	},
};

const server = new Modbus_Server(handler, { tcp: ':502', unit_id: [1, 2] });
server.on('handler_error', (error) => console.error(error));
await server.start();
```

服务端选定传输方式的方式与客户端相同；主机为空，例如 `':502'`，表示绑定 `0.0.0.0`。串口上的
RTU 写作 `{ serial: '/dev/ttyUSB0', baud_rate: 19200 }`，RTU over TCP 写作
`{ rtu_over_tcp: ':4001' }`。

- **单点方法：** `get_coil`、`get_discrete_input`（可选；没有它时功能码 2 读线圈）、
  `get_holding_register`、`get_input_register`、`set_coil`、`set_holding_register`。
- **成批方法（可选）：** `get_coils`、`get_discrete_inputs`、`get_holding_registers`、
  `get_input_registers`、`set_coils`、`set_holding_registers`。提供后，一个请求以它的全部点
  调用一次，例如一步更新一个跨多个寄存器的值。成批读可以返回 `Array` 或类型化数组，比如你自己
  存储区的视图。
- `handler` 是同步的；请把数据放在内存里。
- 寄存器值必须是 `0..65535` 的整数。
- 要拒绝一个请求，抛出 `exception_code` 为 `0x01`、`0x02`、`0x03`、`0x04` 或 `0x06` 的错误，
  例如 `Modbus_Exception`。抛出其他任何值都以 `0x04` 应答，并通过 `handler_error` 报告。

事件：`start`、`stop`、`error`、`socket_connect`、`socket_disconnect`、`socket_error`、`send`、
`receive`、`handler_error`。

## 文档

完整行为见 [doc/spec.zh-cn.md](./doc/spec.zh-cn.md)：
[客户端](./doc/spec-client.zh-cn.md)、[服务端](./doc/spec-server.zh-cn.md)和
[协议](./doc/spec-protocol.zh-cn.md)。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证

ISC
