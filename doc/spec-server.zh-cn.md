# Modbus_Server

> 本文是 [spec-server.md](spec-server.md) 的中文译本。

从站/服务端。`extends EventEmitter`。

## 构造

```js
import { Modbus_Server } from 'es-modbus';

const server = new Modbus_Server(vector, options);
server.start();
```

### options

| 选项      | 默认值      | 含义                                                                          |
| --------- | ----------- | ----------------------------------------------------------------------------- |
| `host`    | `'0.0.0.0'` | 绑定地址（仅 TCP）。                                                          |
| `port`    | `502`       | `number` → 监听该 TCP 端口。`string` → 作为串口设备路径打开。`SerialPort` 实例 → 直接使用（串口）。 |
| `rtu`     | `false`     | `port` 为 `number` 时，在接受的 TCP 套接字上使用 RTU 帧格式（RTU-over-TCP）。串口忽略此项。 |
| `unit_id` | 全部        | 应答哪些 Modbus 单元 ID；省略时为所有 ID（见 `set_unit_ids`）。              |

### 传输方式选择

服务端的传输方式在构造时由 `port` 和 `rtu` 决定：

| `port`                        | `rtu`   | 传输方式       | 行为                                                            |
| ----------------------------- | ------- | -------------- | --------------------------------------------------------------- |
| `number`                      | `false` | TCP            | 监听 `host:port`；每个连接使用带 MBAP 的 Modbus TCP 帧格式。     |
| `number`                      | `true`  | RTU-over-TCP   | 监听 `host:port`；每个连接使用 RTU 帧（单元 ID + PDU + CRC16）。 |
| `string` 或 `SerialPort`      | 忽略    | RTU            | 打开串口，作为 Modbus RTU 从站应答。                             |

RTU 服务端就是串行线路上的 Modbus 从站：它没有连接，并以 CRC-16 封装响应。三种传输方式的请求
处理（单元 ID 路由、`vector`、异常响应）完全相同；只有帧格式和生命周期事件不同。

### `set_unit_ids(unit_id)`

- `null`、`undefined`、`'all'`、`'*'` → 接受**所有**单元 ID（0–255）。这是默认值。
- `number` → 仅接受该 ID。这里的 `0` 是普通 ID（广播地址），不是“所有 ID”的同义词。
- 数字数组 → 恰好接受这些 ID。
- 任何超出 `0..255` 的 ID（包括非整数）都会抛出异常。

发往未被接受的单元 ID 的请求，会得到代码为 `0x0B` 的异常响应。

**广播（单元 ID `0`）。** 发往单元 `0` 的请求是广播。如果单元 `0` 被接受（显式接受，或因为接受所有
ID），写请求会被执行，读请求会被忽略。无论单元 `0` 是否被接受，广播都不会得到应答。

## `vector` 接口

服务端本身不持有数据。每个请求都通过调用下列由调用者提供的函数之一来处理（名称为
`snake_case`）。传入的地址是 **PDU 地址**：线路上的**原始（0 起始）**值，类型为 `number`，绝不是
Modicon 表示法（服务端只使用 PDU 地址）。始终会提供 `unit_id`，因此同一个 `vector` 可以支撑多个
单元。

| 方法                                     | 用于                            | 返回值             |
| ---------------------------------------- | ------------------------------- | ------------------ |
| `get_coil(addr, unit_id)`               | FC 1（线圈）**以及 FC 2**（离散输入） | 真值 = 位已置位 |
| `get_holding_register(addr, unit_id)`   | FC 3                            | `0..65535` 的整数  |
| `get_input_register(addr, unit_id)`     | FC 4                            | `0..65535` 的整数  |
| `set_coil(addr, value, unit_id)`        | FC 5、FC 15                     | 忽略               |
| `set_register(addr, value, unit_id)`    | FC 6、FC 16                     | 忽略               |

参数类型：`addr` 和 `unit_id` 是 `number`；`set_coil` 的 `value` 是 `boolean`；`set_register` 的
`value` 是 `0..65535` 范围内的整数。

**`vector` 是同步的。** 它的函数直接返回值；不支持返回 Promise。被调用时，数据必须实时可达。
推荐把数据保存在内存中（例如一个 `Buffer`）。位于别处的数据（例如 PLC）由调用者负责读入内存并保持
同步，例如由事件驱动；从慢速数据源读取不是 `Modbus_Server` 的使用场景。

没有单独的离散输入访问器 — FC 2 复用 `get_coil`。读访问器会对所请求范围内的每个点各调用一次；
服务端把结果打包/序列化进响应。

**抛出异常的 `vector`。** 如果某个 `vector` 函数抛出异常，服务端会记录该错误，并以异常 `0x04`
（服务器设备故障）应答该请求，而不是返回数据响应。

## 方法

- `start()` — 开始监听（TCP）或打开串口。在先前已 `start()` 之后再次调用是安全的：它会关闭并
  重新打开监听器/端口。
- `stop()` — TCP：销毁所有存活的套接字并关闭服务器。串口：关闭端口。
- `is_valid_unit_id(unit_id)` — 服务端是否接受给定的单元 ID。

## 事件

所有传输方式的事件名都相同；`socket_*` 事件只存在于 TCP 系列传输（TCP 和 RTU-over-TCP）。

| 事件                | 传输方式        | 参数     | 触发时机                                    |
| ------------------- | --------------- | -------- | ------------------------------------------- |
| `start`             | 全部            | —        | 监听器或串口已就绪。                        |
| `stop`              | 全部            | —        | 监听器或串口已关闭，无论是由 `stop()` 还是由传输层自身造成。 |
| `error`             | 全部            | `Error`  | 传输错误。                                  |
| `socket_connect`    | TCP 系列        | `socket` | 有客户端连接。                              |
| `socket_disconnect` | TCP 系列        | `socket` | 有客户端断开。                              |
| `socket_error`      | TCP 系列        | `Error`  | 单个连接的错误。                            |
| `send`              | 全部            | `Buffer` | 一帧已写出。                                |
| `receive`           | 全部            | `Buffer` | 收到一帧。                                  |
