# 设计

> 本文是 [design.md](design.md) 的中文译本。

本库**如何**构建：内部机制、实现现状、已知缺陷和待办事项。行为约定见 `spec-*` 系列；本文记录
实现及粗糙之处，以便后续改动时心中有数。目前这是唯一的设计文档；内容变多后再拆分为
`design-<topic>.md`。

## 传输方式选择

- **客户端。** 构造函数设置 `this.protocol`：`tcp`、`rtu_over_tcp`（字符串地址且 `rtu: true`）
  或 `rtu`（非字符串地址）。
- **解码。** 响应解码**仅**按 `protocol === 'tcp'` 分支，因此 `rtu_over_tcp` 使用 RTU 解析器
  （`parse_rtu_response`）解码。
- **服务端。** 构造函数对 `number` 端口或 `SerialPort` 实例原样保存，对 `string` 端口则包装成新的
  `SerialPort`。`is_tcp` 是一个 getter：`typeof this.port === 'number'`。

## 客户端区间参数（`read` / `write`）

**地址与区间。** `read()` / `write()` 接受一个*区间*（range，见 `spec-protocol.zh-cn.md` 的“区间
表示法”）：一个起始地址加一个长度，功能码（或该表的各功能码）作为区间的属性。*地址*（address）
指单个点：Modicon 地址（`"40001"`）或 PDU 地址（`pdu_addr`，即线路上的数字）。解析器把各种形式的
区间都转换成同一种内部区间对象：`parse_modicon_range` 处理 Modicon 形式，`parse_pdu_range` 处理
结构化 PDU 区间，客户端的 `resolve_range` 在两者之间选择。

`range` 接受的形式（Modicon 字符串，或结构化的数组 / 对象）及其字段规则定义在
`spec-protocol.zh-cn.md` 中；客户端侧的校验见 `spec-client.zh-cn.md`。实现方式如下：

- **先按类型分流。** `read()` / `write()` 调用 `resolve_range`，它在做任何事之前先看 `range`
  的类型：`string` 交给 Modicon 解析器（`parse_modicon_range`），其他一切交给结构化区间校验器
  （`parse_pdu_range`）。任一返回 `null` 即抛出 `Invalid range format`。
- **编号起点。** 构造函数选项 `modicon_zero_based`（默认 `false`，即 1 起始）只影响 Modicon
  解析器。结构化的 `pdu_addr` 原样使用。
- **功能码查找。** Modicon 字符串通过 `MB_prefix_dict`（以首位数字为键）找到表。结构化的
  `func_code` 通过 `MB_func_dict`（以功能码为键）找到表和访问方向（`read` / `write`）。功能码方向
  与方法不符时抛出 `Function code <fc> is not a read function`（或 `write`）。
- **结构化校验。** `parse_pdu_range` 接受恰好三个元素的数组，或带这三个字段的对象；每个
  字段都必须是 `number`（其他键会被忽略），`pdu_addr` 为 `0..65535` 的整数，`length` 为 `>= 1` 的整数。
- **区间检查。** 区间解析完、功能码确定之后，`check_range()` 对两种形式做同样的两项检查：长度必须
  在 `MAX_QUANTITY[func_code]` 之内（`Invalid length …`），且 `pdu_addr + length` 不得超过 `0x10000`
  （`Range exceeds address 65535`）。`write()` 在 `check_write_value` 之后运行它，因此值与功能码
  不符的错误先报告。
- **显式功能码。** 使用 Modicon 字符串时，`write()` 根据 `value` 的形态推断功能码（`infer_write`）；
  使用结构化区间时直接采用给定的 `func_code`。两种情况下随后都由 `check_write_value` 按功能码和
  长度校验 `value`，对 FC 16 把奇数长度的 `Buffer` 作为缓冲区长度错误拒绝。
- **单一事务路径。** 两个方法最终都进入 `transact()`，由它分配 TID、构造帧并保存 packet。

## 帧构造流水线（`Modbus_Client.make_data_packet`）

无论哪种传输方式，所有发出的帧都由同一个例程构造：

1. 分配一个 TCP 形态的缓冲区：读 / 单写为 12 字节，FC 15/16 为 `13 + data_bytes` 字节。
2. 在偏移 6 处写入 PDU（`unit_id`、`func_code`、`start_address`，然后是各 FC 的字段）。
   - FC 1–4：数量位于偏移 10。
   - FC 5：`0xFF00` / `0x0000` 位于偏移 10。
   - FC 6：16 位值位于偏移 10。
   - FC 15/16：数量位于 10，字节数位于 12，数据从 13 开始。
3. 起始地址即 PDU 地址，原样写入。Modicon→PDU 的转换（默认 `point - 1`；当客户端以
   `options.modicon_zero_based = true` 构造时为 `point`）已由 Modicon 解析器完成。
4. 若 `protocol === 'tcp'`：填充 MBAP（偏移 0–5）并返回。
   否则：去掉 6 字节的 MBAP 前缀，追加小端 CRC-16，返回 RTU 帧。

## 客户端事务生命周期

- **包表。** `#packets` 是一个普通数组，按 `tid - TRANSACTION_START` 索引
  （`TRANSACTION_START = 8000`）。`set_packet` / `get_packet` 封装了偏移计算。`packets_length`
  为 256。
- **TID 分配（`get_tid`）。** 非 TCP 始终返回 `TRANSACTION_START`（RTU 没有事务字段）。TCP
  则递增 `#last_tid`，一旦超过 `packets_length + TRANSACTION_START` 就回绕到
  `TRANSACTION_START`。由于只有 256 个槽位，且不检查槽位是否空闲，同时待决的 TCP 事务超过
  256 个就会冲突。
- **`process_packet_transaction`。** 处于重连退避（`_conn_failed`）时，它返回一个已以
  `Error('connection lost')` 拒绝的 Promise；帧从不入队。它同时发出 `error`，但仅当客户端有
  `error` 监听者时：没有监听者时发出 `error` 会抛出异常，而参数合法的调用不得同步抛出。
  否则设置 `status = 'pending'`，递增
  `#trans_count`，创建 Promise，再将缓冲区入队并返回该 Promise。它把 `resolve` / `reject` 闭包以及 `timeout_id` 存放在 packet 上。
  `end_transaction` 递减计数，标记 `status`，清除定时器，并把 `resolve`/`reject` 换成
  `DO_NOTHING`，使迟到/重复的响应无效。
- **匹配（`on_data`）。** 解析 → 发出 `receive` → 跳过 `func_code === 0` → 按 `tid` 查找 →
  除非 `status === 'pending'` 否则忽略 → 有 `exception_code` 则 `reject`，否则兑现：读以
  `response.data` 兑现，写以 `echo_matches()` 的结果兑现。
- **写回显。** `transact()` 保存 `packet.echo`，即写响应在地址之后必须回显的值（`expected_echo()`：
  FC 5 为 `0xFF00` / `0x0000`，FC 6 为值，FC 15/16 为数量；读为 `undefined`）。`echo_matches()` 把响应的
  功能码、单元 ID、起始地址以及回显的值或数量与请求比较；写以比较结果兑现。

## 发送队列 / 背压（`send` → `sending`）

- `send_queue` 是 `{ buffer, on_sent }` 的数组，上限为 `send_queue_size`（256）；溢出时从**队首**切除
  （丢弃最旧的）。`on_sent` 若存在，会在缓冲区交给 `_send` 后立即运行。广播 packet
  （`packet.broadcast`：非 TCP 协议上发往单元 `0` 的任何请求）借它兑现，因为不会有应答：写以
  `true` 兑现，读以空 `Buffer` 兑现。
- `sending` 由 `#busy` 保护，队列为空时立即返回。已连接时，它取出一个缓冲区，调用 `_send`，然后在 `delay` 毫秒后
  清除 `#busy` 并重新进入。这样既串行化了写入，也实现了节流。
- 未连接且没有处于重连退避时，`sending` 以自身作为成功回调触发 `_connect`。它不会在退避期间
  运行：退避只在连接丢失后开始，此时 `abort_pending()` 已清空队列，而退避期间发出的请求在入队
  之前就被拒绝。
- **`abort_pending()`。** 清空 `send_queue`，并以 `Error('connection lost')` 拒绝每个 `status` 为
  `'pending'` 的 packet。它在每次传输层 `close` / `error`（TCP 套接字和串口）时运行，因此按需连接
  失败时，其请求也会立即失败。

## 连接状态（TCP，`set_tcp`）

- `_connect(on_connect, on_error)` 挂接一次性的 `connect` / `error` 监听器，二者互相清理；只有
  在尚未处于 `connecting` 时才调用 `socket.connect`。
- 流 `connect` → `is_connected = true`，`_conn_failed = false`，发出 `connect`。
- 流 `close` / `error` → `is_connected = false`，`abort_pending()`，调用 `reconnect()`，发出
  `disconnect` / `error`。
- `reconnect()` — 若 `reconnect_time > 0` 且尚未处于退避，则设置 `_conn_failed = true`，并在
  `reconnect_time` 毫秒后清除它并调用 `_connect()`。

## 解析器说明（`src/util.js`）

- `parse_modicon_range(address_str, zero_based)` 返回
  `{ type, fm_read, fs_write, fm_write, pdu_addr, length }`（对于缺少相应操作的表，对应字段不存在）；
  对非字符串、不匹配的字符串、不支持的表数字、超范围的点号或 `,0` 长度，返回 `null`。它由三步组成：
  `split_modicon`（正则表达式；5 位与 6 位形式只在点号的位数上不同）、用 `MB_prefix_dict` 查找表的
  数字，以及 `point_to_pdu_addr`（应用编号起点；PDU 地址超出 `0..65535` 即拒绝该点号，这对两种形式、
  两种起点都恰好得出 `spec-protocol.zh-cn.md` 中的范围）。
- `read()` / `write()` 在构造帧之前校验参数并同步抛出异常：`unit_id` 必须是 `0..255` 范围内的
  整数，长度必须在该功能码的 `MAX_QUANTITY`（由 `src/util.js` 导出）之内，FC 6 的值必须是
  `0..65535` 范围内的整数。
- 按功能码校验所支持的功能码和 PDU 长度：定长功能要求长度精确相等，多写请求要求
  `7 + byte_count`。任何失败都产生 `func_code: 0`，由调用方丢弃。
- `parse_tcp` 要求 ≥ 9 字节、协议 ID `== 0`、长度字段在 `3..253`，且完整的 `6 + length` 字节
  都已存在；它为每个帧切出 `6 + length` 字节，并循环从一个数据块中提取多个帧，直到缓冲区耗尽
  或遇到格式错误的头。它会静默丢弃功能码字节 `< 1` 的帧。
- `modbus_crc16(bytes, previous?)` 采用查表实现（256 项 `Int32Array`）；`previous` 允许跨数据块
  增量计算。
- RTU 解析器合成 `tid = TRANSACTION_START`（8000，因为 RTU 没有事务字段），校验 PDU 长度（`3..253`），校验各 FC 的字节布局，
  然后验证 CRC — 任何失败都归结为 `{ tid, func_code: 0, buffer }`。
- 请求解析器对功能码不受支持但在 `1..127` 之内的帧设置 `illegal_function`（同时 `func_code: 0`）；
  对 RTU，仅当整个缓冲区的 CRC 有效时才设置。其他任何失败都使其为 `undefined`。
- 响应解析器把 `func_code > 127` 且 PDU 为 3 字节的情形视为异常并读取异常码字节；其他无法识别
  的情形变为 `func_code: 0`。

## 服务端分发说明

- `on_data` 依据**是否存在 `socket` 参数**来选择解析器，而不是依据 `is_tcp`。
- `handle_read_bits` 服务 FC 1 和 FC 2；`handle_read_registers` 服务 FC 3（保持）和 FC 4（输入），
  通过 `function_code === 3` 分支。
- `send_response` 依据同样的"是否存在 `socket`"判断来组帧：TCP 用 MBAP，串口用 CRC。

### 请求流程

1. `on_data(buffer, socket?)` — 存在 `socket` 时用 `parse_tcp_request` 解析，否则用
   `parse_rtu_request`。逐帧发出 `receive`。`func_code: 0` 的帧被丢弃，除非解析器设置了
   `illegal_function`；此时以该功能码继续处理。
2. `_on_data(request, socket?)` — RTU 帧格式（没有 `socket`）时 `serial_bus` 为真；待 RTU-over-TCP
   得到服务后也应包含它。在串行总线上，广播（单元 `0`）从不应答：若单元 `0` 被接受且功能为写
   （5、6、15、16），则执行并丢弃响应，其余一律丢弃；未被接受的单元 ID 静默丢弃。在 TCP 上单元
   `0` 是普通单元，未被接受的单元 ID 得到 `0x0B`。否则由 `serve()` 调用 `dispatch()`，按
   `func_code` 分支到对应的 `handle_*` 方法，由其调用 `vector` 并构造响应 PDU。不支持的功能码 →
   以其自身功能码（`fc | 0x80`）应答异常 `0x01`。
   - 在调用任何 `vector` 之前，`check_request()` 按 Modbus 应用协议校验受支持的请求：数量超出
     `1..MAX_QUANTITY[fc]`、字节数与数量不符（FC 15/16），或 FC 5 的值不是 `0xFF00` / `0x0000` 时
     为 `0x03`；然后区间结束于地址 65535 之后时为 `0x02`。校验失败的请求以该异常应答，不调用
     `vector`。字节数与数量相符却超限的 FC 15/16 请求不会出现：它放不进 253 字节的 PDU。
   - 每次 `vector` 调用都经过 `call_vector`，它把抛出的异常包装为私有的 `Vector_Error`。
     `serve()` 只捕获 `Vector_Error`：以原始错误和请求发出 `vector_error`，并应答异常 `0x04`。
     没有监听者的 `vector_error` 会被忽略。其他异常属于程序缺陷，会向外传播。
3. `send_response(pdu, socket?, tid, pid)` — TCP：前置新的 MBAP 头并 `socket.write`。
   串口：追加 CRC-16（小端）并 `port.write`。发出 `send`。

---

## RTU / 串口：未完成的工作

**状态：未完成。** 目前只有 Modbus TCP 是完整的。`rtu`（串口）和 `rtu_over_tcp` 属于范围之内
（见 `spec.zh-cn.md`），但必须视为不受支持。部分代码已存在：`src/util.js` 中的编解码
（`parse_rtu_request`、`parse_rtu_response`、`modbus_crc16`）、`make_data_packet` 的客户端 RTU
分支、`Modbus_Client.set_serial` 和 `Modbus_Server.set_rtu`。它们尚未完成，也没有端到端地跑通过。
本节即待办清单；只有当某项在代码中真正修复后才能删除它。`spec-*` 文件描述的是目标约定，因此其中与 RTU / 串口
相关的行目前并不由代码保证，且清单清空时它们也不需要改动。

每一项都是缺陷或缺失的部分，而不是预期行为。

### 客户端

- [ ] **串口构造路径。** `set_serial` 标记为 `@todo not finished`，且从未给 `this._connect`
  赋值，而构造函数在 `reconnect_time > 0` 时会调用 `this._connect()`。构造串口客户端会抛出异常。
  串口的重连和 `is_connected` 处理也尚未定义。
- [ ] **固定的事务 ID。** RTU 没有事务字段，因此所有 RTU 请求共用 `TRANSACTION_START`；并发请求
  会互相覆盖各自的 packet 槽位。RTU 需要严格的请求/响应串行化（同一时刻只有一个未完成的请求），
  目前尚未实现。

### 服务端

- [ ] **没有 `rtu_over_tcp` 模式。** 构造函数没有 `rtu` 选项（见 `spec-server.zh-cn.md`），
  且 `on_data` / `send_response` 依据是否存在 `socket` 来选择帧格式，因此每个 TCP 套接字都被当作
  MBAP 解码。无法提供 TCP 上的 RTU 帧服务。帧格式必须依据所配置的传输方式选择，而不是依据是否
  存在 `socket`。
- [ ] **没有 RTU 帧界定。** `spec-protocol.zh-cn.md`（“帧的界定”）要求串口帧以至少 3.5 个字符
  时间的静默来界定，RTU-over-TCP 的帧则由功能码和字节数隐含的长度来界定。`on_data` 却把每个收到
  的数据块直接交给 `parse_rtu_request`，因此跨数据块拆分的帧，或一个数据块里的多个帧，会被丢弃
  或误解析。（由代码推断，未在硬件上验证。）
- [ ] **串口路径未经端到端验证。** `test/serial.test.js` 通过一对串口测试 RTU 服务端和客户端，
  但在开发机上 com0com 端口对未通过套件的预检，串口测试被跳过（见 `spec-test.zh-cn.md`
  “串口测试环境”）。RTU 服务端路径目前只由使用伪串口的单元测试覆盖。

### 依赖

- [ ] **`serialport` 被无条件导入。** 它已声明为可选 peer 依赖（`peerDependencies` `>=10.0.0` +
  `peerDependenciesMeta.optional`），并在 `rolldown.config.js` 中保持 `external`，但
  `src/ModbusServer.js` 仍在模块顶层执行 `import { SerialPort } from 'serialport'`。因此在未安装
  `serialport` 时导入本包，会对**所有**用户抛出异常，包括只用 TCP 的用户。要做到真正可选，需要
  仅在串口路径上惰性执行 `import('serialport')`（并把 `instanceof SerialPort` 换成鸭子类型判断）。
  注意：开发时 pnpm 的 `autoInstallPeers` 会把它装进本仓库自己的 `node_modules`，这会在本地掩盖
  这个问题。

---

## 已知缺陷 / 不一致（截至撰写时）

这些**不是**预期的规格 — 它们是需要留意、并且最好修复的缺陷。
RTU / 串口的缺陷列在上一节，不在此处。缺陷修复后即从本表删除；其余缺陷保留原编号，编号永不复用。

大多数缺陷是把代码对照 `spec-*` 系列审查后发现的。标注*（已验证）*的项已通过实际运行代码复现，
其余由阅读代码推出。它们同样影响 TCP 路径，而不仅仅是 RTU。

- **缺陷 3 — 没有 lint 配置。** 自动化测试套件已经存在（`spec-test.zh-cn.md`）；lint 配置尚无。

---

## 待决问题

spec 尚未做出的决定。先在 spec 中定下来，再去实现。

- **串口参数。** 服务端 `string` 类型的 `port` 被传给 `new SerialPort(port)`，但 `serialport` 需要
  一个选项对象（路径、波特率、校验位……）。除了直接传入现成的 `SerialPort` 实例，spec 没有定义
  给出串口参数的方法。
- **不完整的 TCP 帧。** 对 TCP，spec 只要求拆分被合并的帧（对 RTU-over-TCP 则要求按长度界定）。
  代码还会丢弃末尾不完整的帧，而不是缓冲到下一次读取（客户端的 `unprocessed_buffer` 字段未被
  使用）。需要决定 TCP 是否也要求缓冲。
- **`start()` / `stop()` 的返回值。** `listen()` 和串口 `open()` 是异步完成的；统一后的
  `start` / `stop` 事件就是通知信号。需要决定 `start()` / `stop()` 是否还应返回 Promise（就绪时
  兑现，失败时拒绝）。
- **连接抖动（除颤）。** 客户端只依据套接字的 `connect` / `close` / `error` 事件设置
  `is_connected`，没有别的机制：没有 keep-alive，没有心跳，也没有平滑。已关闭的 TCP 套接字无法
  恢复，在其上发出的请求的响应也永远不会到达，因此延迟“连接丢失”的拒绝只会推迟失败。抖动真正
  带来的代价是：`reconnect_time` 很小时的重连风暴，以及调用者看到的 `connect` / `disconnect`
  事件噪声。相反的问题是半开连接（拔掉网线、对端消失而没有 FIN）：此时不会触发任何事件，客户端
  只能看到超时。需要决定是否增加 (a) 最小或递增的重连延迟，以及 (b) 死链检测，例如连续 N 次超时
  后关闭套接字，或启用 TCP keep-alive。
- **`disconnect()` 与自动重连。** `disconnect()` 结束套接字，随后 `close` 事件会触发重连定时器，
  因此 `reconnect_time > 0` 时，显式 `disconnect()` 之后客户端会自行重连（这是按字面遵循 spec 的
  重连规则）。需要决定显式 `disconnect()` 是否应抑制重连。
