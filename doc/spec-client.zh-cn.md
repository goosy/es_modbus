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
  - **非字符串**（例如 `null`）→ 在设备路径 `options.port` 上的串口 RTU 传输，使用下文的串口选项。
    串口由客户端自行创建；不接受传入的串口实例。

```js
const client = new Modbus_Client(null, { port: 'COM3', baud_rate: 19200, parity: 'even' });
```

### options

| 选项             | 默认值  | 含义                                                                    |
| ---------------- | ------- | ----------------------------------------------------------------------- |
| `port`           | `502`   | TCP 端口。串口客户端中为串口设备路径（非空 `string`；否则抛出 `Invalid serial port`）。 |
| `rtu`            | `false` | 地址为字符串时，在 TCP 套接字上使用 RTU 帧格式。                        |
| `timeout`        | `1000`  | 单事务响应超时，毫秒。到期时请求被拒绝，并发出 `timeout` 事件。         |
| `delay`          | `20`    | 连续两次帧写入之间的最小间隔，毫秒（发送节流）。                        |
| `reconnect_time` | `10000` | TCP 和 RTU-over-TCP 的重连延迟，毫秒。`> 0` 同时使构造函数立即连接（串口则打开端口）；`0` 禁用定时重连。二者都只在 `enable_reconnect` 为真时生效。 |
| `silence`        | `50`    | 静默时间（ms），超过之后处理不完整帧留下的残留字节（见 `spec-protocol.zh-cn.md` 的“帧的界定”）。必须是有限的正数（否则抛出 `Invalid silence`）。串口上至少为 3.5 个字符时间（19200 波特以上为 1.75 ms）。 |
| `modicon_zero_based` | `false` | `true` 选择 0 起始的 Modicon 点号编号（见下文）。 |
| `baud_rate`      | `9600`  | 串口波特率，正整数（否则抛出 `Invalid baud rate`）。 |
| `parity`         | `'none'` | 串口校验位：`'none'`、`'odd'`、`'even'`，或 `0` = 无、`1` = 奇、`2` = 偶。其他值抛出 `Invalid parity`。 |
| `data_bits`      | `8`     | 串口数据位：`5`、`6`、`7` 或 `8`（否则抛出 `Invalid data bits`）。 |
| `stop_bits`      | `1`     | 串口停止位：`1`、`1.5` 或 `2`（否则抛出 `Invalid stop bits`）。 |

串口选项（`baud_rate`、`parity`、`data_bits`、`stop_bits`）只对串口客户端生效，对 TCP 系列客户端
会被忽略。它们在构造时校验，无效时构造函数抛出异常；串口本身在首次打开时才创建（见“串口”）。

当 `reconnect_time > 0` 时，构造函数会自动打开连接。`reconnect_time = 0` 时，连接丢失后客户端不会
自行重连，但仍会按需连接：第一个请求（或 `connect()`）会打开连接。

### `enable_reconnect`

只读的 `boolean` 属性，表示客户端是否可以自行打开连接。从调用 `disconnect()` 的那一刻起，到之后
某次 `connect()` 重新开始连接为止，它为 `false`；其余时间（包括构造后）为 `true`。它不被直接设置，
而是由客户端的连接阶段推出（见 `design.zh-cn.md`）。

- **`true`** — 各处所述的自动机制照常生效：连接丢失后的定时重连（`reconnect_time > 0`，TCP 和
  RTU-over-TCP），以及由请求触发的按需连接（所有传输）。
- **`false`**（手动关闭）— 客户端绝不自行打开连接：不启动重连定时器；请求被立即以
  `Error('connection lost')` 拒绝，既不入队，也不打开连接。此类请求不发出 `error` 事件：连接断开
  是调用者自己关闭的结果。只有 `connect()` 会重新打开连接。

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
- 请求待决期间连接丢失，或请求在重连退避期间、`enable_reconnect` 为假时发出：消息为
  `connection lost` 的 `Error`（见“连接丢失”）。

### `write(range, value, unit_id = 1) → Promise<boolean>`

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
以写入是否得到确认兑现：Modbus 写响应会回显其请求（功能码、单元 ID 和地址，以及 FC 5/6 的值或
FC 15/16 的数量）。回显与请求一致时为 `true`，不一致时为 `false`。拒绝的情形与 `read` 相同（超时、
异常响应、连接丢失）。

### `connect() → Promise<void>`

已连接时立即兑现；重连退避期间以 `Error('ERR_ILLEGAL_STATE')` 拒绝；否则尝试连接（串口则打开
端口），这会使 `enable_reconnect` 恢复为 `true`。

若某次 `disconnect()` 仍在关闭传输，`connect()` 先等待该关闭完成，因此 `disconnect()` 之后紧接着
的 `connect()` 绝不会以正在关闭的连接兑现。等待期间 `enable_reconnect` 保持为 `false`，因此其间
发出的请求会被拒绝。等待期间调用 `disconnect()` 会取消这次 `connect()`：它以
`Error('connection lost')` 拒绝。

### `disconnect() → Promise<void>`

显式关闭，在下一次 `connect()` 之前抑制一切自动重连：

1. 首先同步地使 `enable_reconnect` 变为 `false`。
2. 取消待决的重连定时器并结束退避，使之后的 `connect()` 不会以 `ERR_ILLEGAL_STATE` 拒绝。
3. 关闭传输，放弃仍在进行中的连接或打开。待决请求与任何连接丢失时一样以 `connection lost`
   拒绝，传输关闭时发出 `disconnect`。

传输关闭后（在 `disconnect` 事件之后）兑现；传输本已关闭时立即兑现。它绝不拒绝。并发的多次调用在
同一次关闭时一同兑现。

## 事件

| 事件         | 参数                | 触发时机                                                |
| ------------ | ------------------- | ------------------------------------------------------- |
| `connect`    | —                   | 传输已连接。                                            |
| `disconnect` | —                   | 传输已关闭。                                            |
| `error`      | `Error` \| `string` | 套接字错误，或在没有可用连接时尝试发送。                |
| `timeout`    | —                   | 某个事务的 `timeout` 到期仍无响应。                     |
| `send`       | `Buffer`            | 一帧已写入线路（完整帧，含 MBAP/CRC）。                 |
| `receive`    | `Buffer`            | 从线路解析出一帧（逐帧触发，早于匹配）。                |
| `data`       | 兑现值              | 某个事务兑现：读为载荷 `Buffer`，写为 `boolean` 结果。 |
| `data_error` | —                   | 某个事务被拒绝（异常或显式 reject）。                   |

`send` / `receive` 是线路跟踪钩子；`data` / `data_error` 对应 Promise 的结算结果。

## 行为约定

- **事务 ID。** 在 TCP 上，客户端在每个请求头中放入一个事务 ID；服务端原样返回，客户端据此匹配
  响应。超时拒绝会以该 ID 标识事务。ID 如何分配不作规定。
- **并发。** TCP 上可同时存在多个未完成的 `read`/`write` 调用，没有对应待决事务的响应会被忽略。
  RTU 系列传输没有事务 ID，因此同一时刻只能有一个未完成的请求，请求必须串行化。
- **广播（RTU、RTU-over-TCP）。** 在串行总线上，发往单元 `0` 的每个请求都是广播：从站执行广播写、
  忽略广播读，且从不应答。帧写出后 promise 立即兑现，不等待应答：写以 `true` 兑现（没有回显可
  校验），读以空 `Buffer` 兑现（没有数据）。若帧写出之前连接丢失，仍以 `connection lost` 拒绝。
  在 TCP 上单元 `0` 是普通单元。
- **顺序/节流。** 发出的帧先入队，逐个写入，且两次写入之间至少间隔 `delay` 毫秒。队列有上限
  （256）；溢出时**最旧**的排队帧会被丢弃。
- **超时按事务计**，而非按连接计。超时之后到达的迟到响应会被丢弃。
- **连接丢失。** 连接丢失时，每个待决请求（无论已发出还是仍在队列中）都被立即以 `Error`（消息为
  `connection lost`）拒绝，排队的帧被丢弃，因此不会有请求在被报告失败之后又被执行。在重连退避
  期间或 `enable_reconnect` 为假时发出的请求会被立即拒绝，而不是入队。
- **重连（TCP 和 RTU-over-TCP）。** 发生 `close` 或 `error` 时，若 `reconnect_time > 0` 且
  `enable_reconnect` 为真，客户端在该延迟后重试；退避期间调用 `connect()` 会以
  `ERR_ILLEGAL_STATE` 拒绝。`disconnect()` 之后不会重试。
- **串口。** `reconnect_time > 0` 时串口在构造时创建并打开，否则由第一个请求或 `connect()` 按需
  创建并打开；并发的调用者共用同一次打开。创建串口时才加载 `serialport` 及其原生绑定，因此在原生
  绑定无法加载的平台上，失败发生在这里，而不是在导入时。创建或打开失败时发出 `error`、拒绝
  `connect()`，并以 `connection lost` 拒绝所有待决请求；之后的请求或 `connect()` 会重试。已关闭的
  串口绝不自动重新打开（关闭通常意味着设备已不在）；下一个请求（`enable_reconnect` 为真时）或
  `connect()` 会再次打开它。`disconnect()` 之后，请求不会打开串口。
