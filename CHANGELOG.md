# Changelog

## v0.3.0-beta.5 - 2026-11-12

### Breaking changes

- The transport is selected by exactly one of the options `tcp`, `rtu_over_tcp` and `serial`,
  on both sides:
  - `Modbus_Client` takes a single options object: `new Modbus_Client({ tcp: '10.0.0.5:502' })`,
    `{ rtu_over_tcp: 'gateway:4001' }` or `{ serial: 'COM3', baud_rate: 19200 }`. The `address`
    parameter and the `port` and `rtu` options are removed.
  - `Modbus_Server` keeps `(handler, options)`, with `{ tcp: '0.0.0.0:502' }`,
    `{ rtu_over_tcp: ':4001' }` or `{ serial: 'COM4' }`. The `host`, `port` and `rtu` options are
    removed, and there is no longer a default of TCP on `0.0.0.0:502`.
  - A `host:port` target may omit the port (`502`) and takes IPv6 in brackets (`'[::1]:502'`);
    port `0` is not accepted. A server may leave the host empty to bind `0.0.0.0`.
- An option that does not apply to the selected transport throws
  `Option <name> does not apply to <transport>` instead of being ignored, e.g. `baud_rate` on a
  TCP client or `keep_alive` on a serial client.

### Server

- A `handler` can reject a request with an exception code of its choice: a thrown value whose
  `exception_code` is `0x01`, `0x02`, `0x03`, `0x04` or `0x06` is answered with that code, and
  no `handler_error` is emitted. The new `Modbus_Exception` builds such an error:
  `throw new Modbus_Exception(0x02, 'read-only')`. Anything else thrown still answers `0x04`
  with `handler_error`.

### Both

- The package now ships a README.
- Serial lines use `serialport-rs` 0.7.1. The known issue of v0.3.0-beta.4 (Windows serial reads
  complete one timer tick late) remains.

### Tests

- `pnpm test:serial` runs the serial tests over every direction of a serial port in one
  command: `pnpm test:serial COM4 COM5` runs `COM4,COM5` and then `COM5,COM4`;
  `pnpm test:serial COM4 :502 192.168.89.2:502 192.168.89.2:503` runs the serial port against a
  converter in TCP client mode, then against one in TCP server mode. A failed run does not stop
  the others, and a summary lists each run as `pass` or `FAIL`.
- `MODBUS_SERIAL_PORTS` takes a remote pool, several `host:port` ends separated by `|`
  (`COM3,192.168.1.10:4001|192.168.1.10:4002`), taken in turn, for a converter that keeps only one
  TCP connection.
- The serial tests retry opening a serial port for up to 500 ms, since a port just closed may
  refuse to re-open for a few tens of milliseconds (seen with a CH340 driver). The library itself
  does not retry.

## v0.3.0-beta.5 - 2026-11-12 (中文)

### 破坏性变更

- 客户端和服务端都改为由 `tcp`、`rtu_over_tcp`、`serial` 三个选项中确定的一个来选择传输方式：
  - `Modbus_Client` 只接受一个选项对象：`new Modbus_Client({ tcp: '10.0.0.5:502' })`、
    `{ rtu_over_tcp: 'gateway:4001' }` 或 `{ serial: 'COM3', baud_rate: 19200 }`。移除了 `address`
    参数以及 `port`、`rtu` 选项。
  - `Modbus_Server` 仍是 `(handler, options)`，写作 `{ tcp: '0.0.0.0:502' }`、
    `{ rtu_over_tcp: ':4001' }` 或 `{ serial: 'COM4' }`。移除了 `host`、`port`、`rtu` 选项，
    也不再默认在 `0.0.0.0:502` 上提供 TCP 服务。
  - `host:port` 目标可以省略端口（即 `502`），IPv6 地址写在方括号里（`'[::1]:502'`）；不接受端口 `0`。
    服务端可以留空主机，此时绑定 `0.0.0.0`。
- 不适用于所选传输方式的选项会抛出 `Option <name> does not apply to <transport>`，不再被忽略，
  例如 TCP 客户端的 `baud_rate`，或串口客户端的 `keep_alive`。

### 服务端

- `handler` 可以用自己选定的异常码拒绝请求：抛出值的 `exception_code` 为 `0x01`、`0x02`、`0x03`、
  `0x04` 或 `0x06` 时，以该异常码应答，且不触发 `handler_error`。新增的 `Modbus_Exception`
  用于构造这样的错误：`throw new Modbus_Exception(0x02, 'read-only')`。抛出其他任何值仍以 `0x04`
  应答并触发 `handler_error`。

### 通用

- 发布包中新增 README。
- 串口改用 `serialport-rs` 0.7.1。v0.3.0-beta.4 的已知问题（Windows 上串口读取晚一个系统定时器
  周期完成）仍然存在。

### 测试

- `pnpm test:serial` 一条命令即可在串口的每个方向上运行串口测试：`pnpm test:serial COM4 COM5`
  先运行 `COM4,COM5`，再运行 `COM5,COM4`；`pnpm test:serial COM4 :502 192.168.89.2:502 192.168.89.2:503`
  先对 TCP 客户端模式的转换器运行，再对 TCP 服务端模式的转换器运行。某次运行失败不影响其余运行，
  最后汇总列出每次运行的 `pass` 或 `FAIL`。
- `MODBUS_SERIAL_PORTS` 支持远端池：多个 `host:port` 端用 `|` 分隔
  （`COM3,192.168.1.10:4001|192.168.1.10:4002`），依次轮流使用，适用于只保持一个 TCP 连接的转换器。
- 串口测试打开串口失败时会重试，最长 500 ms，因为刚关闭的串口可能在几十毫秒内无法重新打开
  （在 CH340 驱动上见到过）。库本身不重试。

## v0.3.0-beta.4

### Breaking changes

- The `vector` of `Modbus_Server` is renamed `handler`: the `vector` property is
  now `handler`, and the `vector_error` event is now `handler_error`. The
  constructor still takes it as the first argument.
- The `handler` method `set_register` is renamed `set_holding_register`, matching
  `get_holding_register`; only holding registers are writable in Modbus.
- A register value read from the `handler` must be an integer in `0..65535`. Any
  other value is handled like a throwing `handler`: exception 0x04, and
  `handler_error` with a `TypeError`. Previously an out-of-range value crashed
  the server, and `undefined` was answered as 0.

### Server

- A `handler` may provide the optional batch methods `get_coils`,
  `get_discrete_inputs`, `get_holding_registers`, `get_input_registers`,
  `set_coils` and `set_holding_registers`. FC 1 to 4, 15 and 16 then serve every
  point of a request in one call, so the `handler` can process it as a whole (no
  half-written multi-register values) and do its per-request work once. Without
  them, the single-point methods are called point by point as before.
- A batch read may return an `Array` or a typed array, such as a view of the
  `handler`'s own storage. A result of the wrong type or length is answered with
  exception 0x04 and reported through `handler_error` as a `TypeError`.
- The optional `get_discrete_input` and `get_discrete_inputs` let a `handler`
  keep discrete inputs (FC 2) apart from coils. A `handler` with neither is
  served through the coil methods as before.

### Both

- The new `name` option of `Modbus_Client` and `Modbus_Server`, kept in the
  `name` property, tells instances apart, e.g. in logs.
- Serial lines use `serialport-rs` instead of `serialport`, which fixes the
  stalled serial reads and writes on Windows with Node.js v26.4.0 and later.
  The native addons now ship in `native/`.

### Known issue

- On Windows, a serial read completes about one system timer tick (typically 12
  to 16 ms) after its last byte, so each serial transaction takes that much
  longer; framing is unaffected (DragonWork/node-serialport-rs#30).

## v0.3.0-beta.4 (中文)

### 破坏性变更

- `Modbus_Server` 的 `vector` 改名为 `handler`：`vector` 属性改为 `handler`，`vector_error` 事件改为
  `handler_error`。构造函数仍以它作为第一个参数。
- `handler` 方法 `set_register` 更名为 `set_holding_register`，与 `get_holding_register`
  对应；Modbus 中只有保持寄存器可写。
- 从 `handler` 读出的寄存器值必须是 `0..65535` 内的整数。其他值按 `handler` 抛出异常处理：
  返回异常 0x04，并以 `TypeError` 触发 `handler_error`。以前越界值会使服务端崩溃，
  `undefined` 被当作 0 应答。

### 服务端

- `handler` 可以提供可选的成批方法 `get_coils`、`get_discrete_inputs`、
  `get_holding_registers`、`get_input_registers`、`set_coils` 和 `set_holding_registers`。
  此时 FC 1 至 4、15 和 16 把请求的全部点一次处理，`handler` 可以把它作为整体处理
  （不会出现写了一半的多寄存器值），每个请求的工作也只做一次。没有这些方法时，
  仍像以前一样逐点调用单点方法。
- 成批读可以返回 `Array` 或类型化数组，例如 `handler` 自身存储的视图。类型或长度不对的结果
  以异常 0x04 应答，并以 `TypeError` 通过 `handler_error` 报告。
- 可选的 `get_discrete_input` 和 `get_discrete_inputs` 让 `handler` 把离散输入（FC 2）
  与线圈分开。两者都没有的 `handler` 仍像以前一样通过线圈方法服务。

### 通用

- `Modbus_Client` 和 `Modbus_Server` 新增 `name` 选项，保存在 `name` 属性中，用于区分实例，
  例如在日志中。
- 串口改用 `serialport-rs` 替代 `serialport`，修复了在 Windows 上使用 Node.js v26.4.0
  及以后版本时串口读写停滞的问题。原生插件现在位于 `native/`。

### 已知问题

- 在 Windows 上，串口读取在最后一个字节到达后约一个系统定时器周期（通常 12 到 16 ms）
  才完成，因此每次串口事务都相应变长；帧分隔不受影响（DragonWork/node-serialport-rs#30）。

## v0.3.0-beta.2

The client and server now follow the contract in `doc/spec*.md`, RTU and
RTU-over-TCP are supported on both sides, and the library is covered by an
automated test suite.

### Breaking changes

- Serial lines are configured with flat options (`port`, `baud_rate`, `parity`,
  `data_bits`, `stop_bits`; 9600 8N1 by default) instead of a `SerialPort`
  instance. `serialport` is bundled with its N-API prebuilds, so the package has
  no runtime dependencies; it is loaded only when a serial line is used.
- `write()` resolves with a boolean: whether the response echoes the request.
- Timeouts and exception responses reject with an `Error` instead of a string;
  the messages are unchanged.
- Server unit IDs: `set_unit_ids(0)` accepts only unit 0, and every ID is
  accepted by default. On TCP, unit 0 is an ordinary unit. On a serial bus, unit
  0 is the broadcast address, and a request to a non-accepted unit is not
  answered (previously exception 0x0B).
- The Modicon numbering option is renamed `modicon_zero_based` and is read-only.
  Range errors read `Invalid range format` and
  `Write operation not supported for this table`.
- A server `port` that is neither a number nor a string throws instead of
  falling back to TCP port 502.

### Client

- `read()` and `write()` accept 5- and 6-digit, 0- or 1-based Modicon ranges,
  and structured PDU ranges (`[func_code, pdu_addr, length]` or
  `{ func_code, pdu_addr, length }`). Quantity limits, address overflow and
  write values are checked synchronously.
- Losing the connection rejects every pending and queued request with
  `connection lost`.
- `disconnect()` returns a Promise and stops auto-reconnect until the next
  `connect()`; the new read-only `enable_reconnect` reflects this.
- Reconnects back off exponentially up to the new `reconnect_max` option. On
  TCP, `max_timeouts` (default 3) consecutive timeouts close a dead link, and
  TCP keep-alive starts after `keep_alive` ms (default 10000).
- On RTU and RTU-over-TCP, requests are sent one at a time, mismatched responses
  are ignored, and broadcasts resolve once sent, followed by a `turnaround` wait
  (default 100 ms).
- The timeout starts when a frame is written; a request dropped from a full
  queue rejects at once with `queue overflow`.

### Server

- `start()` and `stop()` return Promises.
- The `rtu` option serves RTU-over-TCP on a TCP port.
- Invalid requests are answered with Modbus exceptions 0x01, 0x02 or 0x03 as the
  protocol requires; malformed frames are dropped. An exception thrown by a
  vector is answered with 0x04 and reported through the `vector_error` event.

### Both

- Frames are delimited by length on every transport: coalesced and split frames
  are handled, and the stream resynchronizes after bad bytes. The new `silence`
  option (default 50 ms, at least 3.5 character times on a serial line) sets
  when leftover bytes are resynchronized or discarded.

### Known issue

- On Windows with Node.js v26.4.0 and later, serial reads and writes can stall
  (serialport/node-serialport#3148). Use Node.js 24 until `serialport` is fixed.

## v0.3.0-beta.2 (中文)

客户端和服务端现在遵循 `doc/spec*.md` 中的约定，两端都支持 RTU 和
RTU-over-TCP，并有自动化测试覆盖。

### 破坏性变更

- 串口改用平铺选项配置（`port`、`baud_rate`、`parity`、`data_bits`、
  `stop_bits`；默认 9600 8N1），不再传入 `SerialPort` 实例。`serialport`
  连同其 N-API 预编译文件一起打包，包本身没有运行时依赖；只有使用串口时才加载。
- `write()` 以布尔值兑现：表示响应是否回显了请求。
- 超时和异常响应以 `Error` 拒绝，不再是字符串；消息内容不变。
- 服务端单元 ID：`set_unit_ids(0)` 只接受单元 0，默认接受所有 ID。TCP 上单元 0
  是普通单元。串行总线上单元 0 是广播地址，发给未接受单元的请求不作应答（原先应答异常 0x0B）。
- Modicon 编号选项改名为 `modicon_zero_based`，且为只读。范围错误的消息改为
  `Invalid range format` 和 `Write operation not supported for this table`。
- 服务端 `port` 既不是数字也不是字符串时抛出异常，不再回退到 TCP 502 端口。

### 客户端

- `read()` 和 `write()` 接受 5 位和 6 位、0 基或 1 基的 Modicon 范围，以及结构化 PDU 范围
  （`[func_code, pdu_addr, length]` 或 `{ func_code, pdu_addr, length }`）。数量上限、
  地址越界和写入值都同步检查。
- 连接断开时，所有待响应和排队中的请求都以 `connection lost` 拒绝。
- `disconnect()` 返回 Promise，并在下一次 `connect()` 之前停止自动重连；新增的只读属性
  `enable_reconnect` 反映这一状态。
- 重连间隔按指数退避，上限由新选项 `reconnect_max` 设定。TCP 上连续 `max_timeouts`
  次超时（默认 3）会关闭失效连接，TCP keep-alive 在 `keep_alive` 毫秒后启用（默认 10000）。
- RTU 和 RTU-over-TCP 上请求逐个发送，不匹配的响应被忽略；广播在发出后即兑现，
  随后等待 `turnaround`（默认 100 ms）。
- 超时从帧写出时开始计时；因队列已满被丢弃的请求立即以 `queue overflow` 拒绝。

### 服务端

- `start()` 和 `stop()` 返回 Promise。
- `rtu` 选项可在 TCP 端口上提供 RTU-over-TCP 服务。
- 无效请求按协议要求以 Modbus 异常 0x01、0x02 或 0x03 应答；格式错误的帧被丢弃。
  vector 抛出的异常以 0x04 应答，并通过 `vector_error` 事件报告。

### 通用

- 所有传输方式都按长度分隔帧：能处理粘连帧和拆分帧，遇到错误字节后会重新同步。
  新选项 `silence`（默认 50 ms，串口上至少为 3.5 个字符时间）决定何时对剩余字节重新同步或丢弃。

### 已知问题

- 在 Windows 上使用 Node.js v26.4.0 及以后版本时，串口读写可能停滞
  （serialport/node-serialport#3148）。在 `serialport` 修复之前请使用 Node.js 24。
