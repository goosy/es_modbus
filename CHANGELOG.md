# Changelog

## v0.3.0 - 2026-11-13

A rework of the client and server since v0.1.4: they follow the contract in `doc/spec*.md`,
Modbus TCP, RTU on a serial port and RTU over TCP are supported on both sides, and the library is
covered by an automated test suite. The package has no runtime dependencies and ships a README.

### Breaking changes

- The transport is selected by exactly one of the options `tcp`, `rtu_over_tcp` and `serial`,
  on both sides:
  - `Modbus_Client` takes a single options object: `new Modbus_Client({ tcp: '10.0.0.5:502' })`,
    `{ rtu_over_tcp: 'gateway:4001' }` or `{ serial: 'COM3', baud_rate: 19200 }`. The `address`
    parameter is removed.
  - `Modbus_Server` keeps `(handler, options)`, with `{ tcp: '0.0.0.0:502' }`,
    `{ rtu_over_tcp: ':4001' }` or `{ serial: 'COM4' }`. The `host` and `port` options are
    removed, and there is no longer a default of TCP on `0.0.0.0:502`.
  - A `host:port` target may omit the port (`502`) and takes IPv6 in brackets (`'[::1]:502'`);
    port `0` is not accepted. A server may leave the host empty to bind `0.0.0.0`.
  - An option that does not apply to the selected transport throws
    `Option <name> does not apply to <transport>`, e.g. `baud_rate` on a TCP client.
- Serial lines are configured with flat options (`baud_rate`, `parity`, `data_bits`,
  `stop_bits`; 9600 8N1 by default) instead of a `SerialPort` instance. Serial support is bundled
  as prebuilt native addons (`serialport-rs`, in `native/`) and loaded only when a serial line is
  first used.
- The server's `vector` is now the `handler`, and its methods use snake_case: `get_coil`,
  `get_input_register`, `get_holding_register`, `set_coil` and `set_holding_register` (formerly
  `setRegister`). A register value read from it must be an integer in `0..65535`.
- The client's `transport` event is replaced by `send` and `receive`, which carry the frame as a
  `Buffer`; the server emits them too.
- `write()` resolves with a boolean: whether the response echoes the request. Timeouts and
  exception responses reject with an `Error` instead of a string.
- Server unit IDs: every ID is accepted by default, and `set_unit_ids(0)` accepts only unit 0.
  On TCP, unit 0 is an ordinary unit. On a serial bus, unit 0 is the broadcast address, and a
  request to a non-accepted unit is not answered.
- The Modicon numbering option `zero_based` is renamed `modicon_zero_based` and is read-only.
- Node.js 20.11 or later is required.

### Client

- `read()` and `write()` accept 5- and 6-digit, 0- or 1-based Modicon ranges, and structured PDU
  ranges (`[func_code, pdu_addr, length]` or `{ func_code, pdu_addr, length }`). Ranges, quantity
  limits, unit IDs and write values are checked synchronously; the unit ID defaults to 1.
- Each request has a `timeout` (default 1000 ms) that starts when its frame is written, and
  frames are paced by `delay` (default 20 ms). A request dropped from a full queue rejects at once
  with `queue overflow`, and losing the connection rejects every pending and queued request with
  `connection lost`.
- Reconnects back off exponentially from `reconnect_time` up to `reconnect_max`. `disconnect()`
  returns a Promise and stops auto-reconnect until the next `connect()`, as the read-only
  `enable_reconnect` shows.
- On TCP, `max_timeouts` (default 3) consecutive timeouts close a dead link, and TCP keep-alive
  starts after `keep_alive` ms (default 10000).
- On RTU and RTU over TCP, requests are sent one at a time, mismatched responses are ignored, and
  broadcasts resolve once sent, followed by a `turnaround` wait (default 100 ms).

### Server

- `start()` and `stop()` return Promises.
- Invalid requests are answered with exception 0x01, 0x02 or 0x03 as the protocol requires;
  malformed frames are dropped.
- A `handler` can reject a request with an exception code of its choice: a thrown value whose
  `exception_code` is `0x01`, `0x02`, `0x03`, `0x04` or `0x06` is answered with that code. The new
  `Modbus_Exception` builds such an error: `throw new Modbus_Exception(0x02, 'read-only')`.
  Anything else thrown, and a register value of the wrong type or range, answers `0x04` and is
  reported through the `handler_error` event.
- A `handler` may provide the optional batch methods `get_coils`, `get_discrete_inputs`,
  `get_holding_registers`, `get_input_registers`, `set_coils` and `set_holding_registers`. FC 1
  to 4, 15 and 16 then serve every point of a request in one call, so the `handler` can process it
  as a whole (no half-written multi-register values). A batch read may return an `Array` or a
  typed array, such as a view of the `handler`'s own storage.
- The optional `get_discrete_input` and `get_discrete_inputs` keep discrete inputs (FC 2) apart
  from coils; without them FC 2 reads the coils.

### Both

- Frames are delimited by length on every transport: coalesced and split frames are handled, and
  the stream resynchronizes after bad bytes. The `silence` option (default 50 ms, at least 3.5
  character times on a serial line) sets when leftover bytes are resynchronized or discarded.
- The new `name` option, kept in the `name` property, tells instances apart, e.g. in logs.
- Serial lines use `serialport-rs` 0.7.3. The serial issues of the prereleases are fixed: reads
  and writes no longer stall on Windows with Node.js v26.4.0 and later, and a Windows serial read
  no longer completes one timer tick late.

## v0.3.0 - 2026-11-13 (中文)

自 v0.1.4 以来对客户端和服务端的一次重写：两者遵循 `doc/spec*.md` 中的约定，两端都支持
Modbus TCP、串口上的 RTU 以及 RTU over TCP，并有自动化测试覆盖。包本身没有运行时依赖，并附带 README。

### 破坏性变更

- 客户端和服务端都改为由 `tcp`、`rtu_over_tcp`、`serial` 三个选项中确定的一个来选择传输方式：
  - `Modbus_Client` 只接受一个选项对象：`new Modbus_Client({ tcp: '10.0.0.5:502' })`、
    `{ rtu_over_tcp: 'gateway:4001' }` 或 `{ serial: 'COM3', baud_rate: 19200 }`。移除了 `address` 参数。
  - `Modbus_Server` 仍是 `(handler, options)`，写作 `{ tcp: '0.0.0.0:502' }`、
    `{ rtu_over_tcp: ':4001' }` 或 `{ serial: 'COM4' }`。移除了 `host`、`port` 选项，
    也不再默认在 `0.0.0.0:502` 上提供 TCP 服务。
  - `host:port` 目标可以省略端口（即 `502`），IPv6 地址写在方括号里（`'[::1]:502'`）；不接受端口 `0`。
    服务端可以留空主机，此时绑定 `0.0.0.0`。
  - 不适用于所选传输方式的选项会抛出 `Option <name> does not apply to <transport>`，
    例如 TCP 客户端的 `baud_rate`。
- 串口改用平铺选项配置（`baud_rate`、`parity`、`data_bits`、`stop_bits`；默认 9600 8N1），
  不再传入 `SerialPort` 实例。串口支持以预编译原生插件（`serialport-rs`，位于 `native/`）随包提供，
  只在首次使用串口时加载。
- 服务端的 `vector` 改为 `handler`，其方法改用 snake_case：`get_coil`、`get_input_register`、
  `get_holding_register`、`set_coil` 和 `set_holding_register`（原 `setRegister`）。
  从它读出的寄存器值必须是 `0..65535` 内的整数。
- 客户端的 `transport` 事件由 `send` 和 `receive` 取代，以 `Buffer` 携带帧；服务端也触发这两个事件。
- `write()` 以布尔值兑现：表示响应是否回显了请求。超时和异常响应以 `Error` 拒绝，不再是字符串。
- 服务端单元 ID：默认接受所有 ID，`set_unit_ids(0)` 只接受单元 0。TCP 上单元 0 是普通单元。
  串行总线上单元 0 是广播地址，发给未接受单元的请求不作应答。
- Modicon 编号选项 `zero_based` 改名为 `modicon_zero_based`，且为只读。
- 需要 Node.js 20.11 或更高版本。

### 客户端

- `read()` 和 `write()` 接受 5 位和 6 位、0 基或 1 基的 Modicon 范围，以及结构化 PDU 范围
  （`[func_code, pdu_addr, length]` 或 `{ func_code, pdu_addr, length }`）。范围、数量上限、
  单元 ID 和写入值都同步检查；单元 ID 默认为 1。
- 每个请求有 `timeout`（默认 1000 ms），从帧写出时开始计时；帧之间按 `delay`（默认 20 ms）间隔发送。
  因队列已满被丢弃的请求立即以 `queue overflow` 拒绝；连接断开时，所有待响应和排队中的请求都以
  `connection lost` 拒绝。
- 重连间隔从 `reconnect_time` 起按指数退避，上限为 `reconnect_max`。`disconnect()` 返回 Promise，
  并在下一次 `connect()` 之前停止自动重连，只读属性 `enable_reconnect` 反映这一状态。
- TCP 上连续 `max_timeouts` 次超时（默认 3）会关闭失效连接，TCP keep-alive 在 `keep_alive`
  毫秒后启用（默认 10000）。
- RTU 和 RTU over TCP 上请求逐个发送，不匹配的响应被忽略；广播在发出后即兑现，
  随后等待 `turnaround`（默认 100 ms）。

### 服务端

- `start()` 和 `stop()` 返回 Promise。
- 无效请求按协议要求以异常 0x01、0x02 或 0x03 应答；格式错误的帧被丢弃。
- `handler` 可以用自己选定的异常码拒绝请求：抛出值的 `exception_code` 为 `0x01`、`0x02`、`0x03`、
  `0x04` 或 `0x06` 时，以该异常码应答。新增的 `Modbus_Exception` 用于构造这样的错误：
  `throw new Modbus_Exception(0x02, 'read-only')`。抛出其他任何值，或寄存器值的类型、范围不对，
  都以 `0x04` 应答并通过 `handler_error` 事件报告。
- `handler` 可以提供可选的成批方法 `get_coils`、`get_discrete_inputs`、`get_holding_registers`、
  `get_input_registers`、`set_coils` 和 `set_holding_registers`。此时 FC 1 至 4、15 和 16
  把请求的全部点一次处理，`handler` 可以把它作为整体处理（不会出现写了一半的多寄存器值）。
  成批读可以返回 `Array` 或类型化数组，例如 `handler` 自身存储的视图。
- 可选的 `get_discrete_input` 和 `get_discrete_inputs` 把离散输入（FC 2）与线圈分开；
  没有它们时 FC 2 读取线圈。

### 通用

- 所有传输方式都按长度分隔帧：能处理粘连帧和拆分帧，遇到错误字节后会重新同步。
  `silence` 选项（默认 50 ms，串口上至少为 3.5 个字符时间）决定何时对剩余字节重新同步或丢弃。
- 新增 `name` 选项，保存在 `name` 属性中，用于区分实例，例如在日志中。
- 串口使用 `serialport-rs` 0.7.3。各预发布版本的串口问题均已修复：在 Windows 上使用 Node.js
  v26.4.0 及以后版本时串口读写不再停滞，Windows 上的串口读取也不再晚一个定时器周期完成。
