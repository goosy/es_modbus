# Modbus_Client

> 本文是 [spec-client.md](spec-client.md) 的中文译本。

主站/客户端。`extends EventEmitter`。

## 构造

```js
import { Modbus_Client } from 'es-modbus';

const client = new Modbus_Client(address, options);
```

- `address`
  - **字符串** → TCP 系列传输：TCP；当 `options.rtu` 为真时为 RTU-over-TCP。
  - **非字符串**（预期为 `SerialPort` 实例）→ 串口 RTU 传输。

### options

| 选项             | 默认值  | 含义                                                                    |
| ---------------- | ------- | ----------------------------------------------------------------------- |
| `port`           | `502`   | TCP 端口（串口忽略）。                                                  |
| `rtu`            | `false` | 地址为字符串时，在 TCP 套接字上使用 RTU 帧格式。                        |
| `timeout`        | `1000`  | 单事务响应超时，毫秒。到期时请求被拒绝，并发出 `timeout` 事件。         |
| `delay`          | `20`    | 连续两次帧写入之间的最小间隔，毫秒（发送节流）。                        |
| `reconnect_time` | `10000` | TCP 和 RTU-over-TCP 的重连延迟，毫秒。`> 0` 同时使构造函数立即连接；`0` 禁用自动重连。 |
| `modicon_zero_based` | `false` | `true` 选择 0 起始的 Modicon 点号编号（见下文）。 |

当 `reconnect_time > 0` 时，构造函数会自动打开连接。`reconnect_time = 0` 时，连接丢失后客户端不会
自行重连，但仍会按需连接：第一个请求（或 `connect()`）会打开连接。

Modicon 地址的编号起点同样在构造时选择：默认 1 起始，以 `modicon_zero_based: true` 选择 0 起始（见
`spec-protocol.zh-cn.md` 的“编号起点”）。它只作用于 Modicon 字符串，绝不作用于结构化的 PDU
区间，且此后不能更改：`modicon_zero_based` 属性是只读的。

## 方法

在 `read` 和 `write` 中，`range` 要么是 Modicon 字符串，要么是结构化 PDU 区间（数组
`[func_code, pdu_addr, length]` 或对象 `{ func_code, pdu_addr, length }`），二者都定义在
`spec-protocol.zh-cn.md` 中。`unit_id` 是 `0..255` 范围内的整数。

当参数无效时，两个方法都会同步抛出异常，而不是返回被拒绝的 promise：

- `range` 不是有效区间（`Error('Invalid range format')`），包括长度小于 `1`；
- `unit_id` 不是 `0..255` 范围内的整数；
- 长度超过其功能码的数量上限（见 `spec-protocol.zh-cn.md`）
  （`Error('Invalid length <length> for function code <fc>')`），两种形式的区间相同；
- 区间结束于 PDU 地址 65535 之后（`Error('Range exceeds address 65535')`）；
- 功能码不属于该方法。

### `read(range, unit_id = 1) → Promise<Buffer>`

功能码和长度来自区间：

- **Modicon 字符串** — 首位数字选出的表给出读功能码（1–4）；长度是 `,N` 后缀，默认 1。
- **结构化** — `func_code` 必须是 `1, 2, 3, 4` 之一；`length` 就是长度。

以响应的**原始载荷字节**（寄存器字为大端，或打包的线圈字节）兑现 — 由调用者自行解码。以下情况会
拒绝：

- 超时：消息中以事务 ID 标识该事务；
- Modbus 异常：`` `response error: <exception_code>` ``；
- 请求待决期间连接丢失，或请求在重连退避期间发出：消息为 `connection lost` 的 `Error`（见
  “连接丢失”）。

### `write(range, value, unit_id = 1) → Promise<Buffer>`

对 Modicon 字符串，功能码由所属的表和 `value` 的形态决定；对结构化区间，由 `func_code` 指定，
且必须是 `5, 6, 15, 16` 之一。

| 所属表 / FC        | `value`                              | 功能码        | 说明 |
| ------------------ | ------------------------------------ | ------------- | ---- |
| 线圈（`0…`）/ 5    | `boolean`                            | 5（单个）     | 非布尔值抛出 `Invalid value for coil write`。 |
| 线圈（`0…`）/ 15   | 长度为 `ceil(length / 8)` 字节的 `Buffer` | 15（多个）  | 长度错误抛出 `Invalid buffer length for coil write`。 |
| 保持（`4…`）/ 6    | `0..65535` 的整数，或 2 字节 `Buffer` | 6（单个）     | |
| 保持（`4…`）/ 16   | 长度为 `length * 2` 字节的 `Buffer`  | 16（多个）    | 长度错误抛出 `Invalid buffer length for register write`。 |

`Buffer` 携带大端的寄存器字和 LSB 优先打包的线圈位。

`length` 是 `,N` 后缀（默认 1），或结构化区间的 `length`。对于没有 `,N` 后缀的寄存器 `Buffer`，
`length` 为 `value.length / 2`；线圈 `Buffer` 始终需要 `,N`，因为无法由字节数推出位数。写入只读表
（离散输入 `1…`、输入寄存器 `3…`）会抛出 `Write operation not supported for this table`。
兑现/拒绝的方式与 `read` 相同。

### `connect() → Promise<void>`

已连接时立即兑现；重连退避期间以 `Error('ERR_ILLEGAL_STATE')` 拒绝；否则尝试连接（串口则打开端口）。

### `disconnect()`

关闭传输。

## 事件

| 事件         | 参数                | 触发时机                                                |
| ------------ | ------------------- | ------------------------------------------------------- |
| `connect`    | —                   | 传输已连接。                                            |
| `disconnect` | —                   | 传输已关闭。                                            |
| `error`      | `Error` \| `string` | 套接字错误，或在没有可用连接时尝试发送。                |
| `timeout`    | —                   | 某个事务的 `timeout` 到期仍无响应。                     |
| `send`       | `Buffer`            | 一帧已写入线路（完整帧，含 MBAP/CRC）。                 |
| `receive`    | `Buffer`            | 从线路解析出一帧（逐帧触发，早于匹配）。                |
| `data`       | 载荷 `Buffer`       | 某个事务成功兑现。                                      |
| `data_error` | —                   | 某个事务被拒绝（异常或显式 reject）。                   |

`send` / `receive` 是线路跟踪钩子；`data` / `data_error` 对应 Promise 的结算结果。

## 行为约定

- **事务 ID。** 在 TCP 上，客户端在每个请求头中放入一个事务 ID；服务端原样返回，客户端据此匹配
  响应。超时拒绝会以该 ID 标识事务。ID 如何分配不作规定。
- **并发。** TCP 上可同时存在多个未完成的 `read`/`write` 调用，没有对应待决事务的响应会被忽略。
  RTU 系列传输没有事务 ID，因此同一时刻只能有一个未完成的请求，请求必须串行化。
- **顺序/节流。** 发出的帧先入队，逐个写入，且两次写入之间至少间隔 `delay` 毫秒。队列有上限
  （256）；溢出时**最旧**的排队帧会被丢弃。
- **超时按事务计**，而非按连接计。超时之后到达的迟到响应会被丢弃。
- **连接丢失。** 连接丢失时，每个待决请求（无论已发出还是仍在队列中）都被立即以 `Error`（消息为
  `connection lost`）拒绝，排队的帧被丢弃，因此不会有请求在被报告失败之后又被执行。在重连退避
  期间发出的请求会被立即拒绝，而不是入队。
- **重连（TCP 和 RTU-over-TCP）。** 发生 `close` 或 `error` 时，若 `reconnect_time > 0`，客户端
  在该延迟后重试；退避期间调用 `connect()` 会以 `ERR_ILLEGAL_STATE` 拒绝。
