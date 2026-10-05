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

## 客户端地址参数（`read` / `write`）

`address` 接受的形式（Modicon 字符串，或结构化的数组 / 对象）及其字段规则定义在
`spec-protocol.zh-cn.md` 中；客户端侧的校验见 `spec-client.zh-cn.md`。实现方式如下：

- **先按类型分流。** `read()` / `write()` 在做任何事之前先看 `address` 的类型：`string` 交给
  Modicon 解析器，数组或对象交给结构化地址校验器。
- **编号起点。** 构造函数选项 `modicon_zero_based`（默认 `false`，即 1 起始）只影响 Modicon
  解析器。结构化的 `pdu_addr` 原样使用。
- **功能码查找。** Modicon 字符串通过 `MB_prefix_dict`（以首位数字为键）找到表。结构化的
  `func_code` 需要它自己的功能码查找（见缺陷 20）。
- **显式功能码。** 使用结构化地址时，`write()` 不再根据 `value` 的形态推断功能码，而是针对
  `func_code` 校验该值。

## 帧构造流水线（`Modbus_Client.make_data_packet`）

无论哪种传输方式，所有发出的帧都由同一个例程构造：

1. 分配一个 TCP 形态的缓冲区：读 / 单写为 12 字节，FC 15/16 为 `13 + data_bytes` 字节。
2. 在偏移 6 处写入 PDU（`unit_id`、`func_code`、`start_address`，然后是各 FC 的字段）。
   - FC 1–4：数量位于偏移 10。
   - FC 5：`0xFF00` / `0x0000` 位于偏移 10。
   - FC 6：16 位值位于偏移 10。
   - FC 15/16：数量位于 10，字节数位于 12，数据从 13 开始。
3. 在此处应用 Modicon→PDU 的转换：PDU 地址默认为 `point - 1`；当客户端以
   `options.modicon_zero_based = true` 构造时为 `point`。`number` 形式的 PDU 地址应原样使用（不做转换）。
   代码目前还保留一个 `0 → 0xFFFF` 的情形，应删除（见缺陷 15 和 17）。
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
- **`process_packet_transaction`。** 设置 `status = 'pending'`，递增 `#trans_count`，将缓冲区
  入队，并返回一个 Promise。它把 `resolve` / `reject` 闭包以及 `timeout_id` 存放在 packet 上。
  `end_transaction` 递减计数，标记 `status`，清除定时器，并把 `resolve`/`reject` 换成
  `DO_NOTHING`，使迟到/重复的响应无效。
- **匹配（`on_data`）。** 解析 → 发出 `receive` → 跳过 `func_code === 0` → 按 `tid` 查找 →
  除非 `status === 'pending'` 否则忽略 → 有 `exception_code` 则 `reject`，否则 `resolve(data)`。

## 发送队列 / 背压（`send` → `sending`）

- `send_queue` 是一个数组，上限为 `send_queue_size`（256）；溢出时从**队首**切除（丢弃最旧的）。
- `sending` 由 `#busy` 保护。已连接时，它取出一个缓冲区，调用 `_send`，然后在 `delay` 毫秒后
  清除 `#busy` 并重新进入。这样既串行化了写入，也实现了节流。
- 未连接且没有处于重连退避时，`sending` 以自身作为成功回调触发 `_connect`。若处于退避期，
  则发出 `error`。

## 连接状态（TCP，`set_tcp`）

- `_connect(on_connect, on_error)` 挂接一次性的 `connect` / `error` 监听器，二者互相清理；只有
  在尚未处于 `connecting` 时才调用 `socket.connect`。
- 流 `connect` → `is_connected = true`，`_conn_failed = false`，发出 `connect`。
- 流 `close` / `error` → `is_connected = false`，调用 `reconnect()`，发出 `disconnect` /
  `error`。
- `reconnect()` — 若 `reconnect_time > 0` 且尚未处于退避，则设置 `_conn_failed = true`，并在
  `reconnect_time` 毫秒后清除它并调用 `_connect()`。

## 解析器说明（`src/util.js`）

- `parse_address` 返回 `{ type, fm_read, fs_write, fm_write, address, length }`（对于缺少相应
  操作的表，对应字段不存在）；对非字符串、不匹配的字符串、不支持的表数字或 `,0` 长度，返回 `null`。
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
- 响应解析器把 `func_code > 127` 且 PDU 为 3 字节的情形视为异常并读取异常码字节；其他无法识别
  的情形变为 `func_code: 0`。

## 服务端分发说明

- `on_data` 依据**是否存在 `socket` 参数**来选择解析器，而不是依据 `is_tcp`。
- `handle_read_bits` 服务 FC 1 和 FC 2；`handle_read_registers` 服务 FC 3（保持）和 FC 4（输入），
  通过 `function_code === 3` 分支。
- `send_response` 依据同样的"是否存在 `socket`"判断来组帧：TCP 用 MBAP，串口用 CRC。

### 请求流程

1. `on_data(buffer, socket?)` — 存在 `socket` 时用 `parse_tcp_request` 解析，否则用
   `parse_rtu_request`。逐帧发出 `receive`。
2. `_on_data(request, socket?)` — 若单元 ID 不被接受则拒绝（`0x0B`）；否则按 `func_code`
   分支到对应的 `handle_*` 方法，由其调用 `vector` 并构造响应 PDU。未知功能码 → 异常 `0x01`。
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
- **缺陷 10 — `write()` 兑现的类型不对。** spec 写的是 `Promise<Buffer>`，但 promise 以
  `response.data` 兑现：FC 5/6 为 `number`，FC 15/16 为 `undefined`。
- **缺陷 11 — 服务端不丢弃格式错误的帧。** `on_data` 把所有解析出的帧（包括 `func_code: 0` 的，
  即长度错误、CRC 错误、不支持的功能码）都交给 `_on_data`，后者以功能码字节为 `0x80`（`0 + 0x80`）
  的异常应答。spec 规定格式错误的帧应丢弃，不支持的功能码应以 `function_code | 0x80` 应答，但原始
  功能码已在解析器中丢失。短到无法携带单元 ID 的帧，会以未定义的单元 ID 得到应答。
- **缺陷 13 — 服务端不校验数量 / 字节数。** 数量很大的读请求会在 `writeUInt8(quantity * 2)` 处
  抛出 `RangeError`（寄存器超过 127 个、线圈超过 2040 个）；`byte_count` 小于 `quantity` 的
  FC 15/16 请求会读到数据之外。两者都在套接字 `data` 处理器内抛出。spec 对此没有定义服务端的上限
  或异常码（见“待决问题”）。
- **缺陷 15 — `make_data_packet` 中的死分支。** `address === 0 ? 0xffff` 不可达，因为
  `parse_address` 会拒绝地址 `0`。待 0 起始编号被正确处理后应删除它（见缺陷 17）。
- **缺陷 16 — 不支持 6 位 Modicon 地址。** `parse_address` 只匹配 `^(\d{5})(,(\d{1,4}))?$`，
  因此 `"400001"` 会被拒绝。spec 要求同时支持 5 位形式（1 起始时点号 `1..9999`，0 起始时
  `0..9999`）和 6 位形式（`1..65536` / `0..65535`），以位数区分。目前对 5 位形式的 `1..65535`
  范围检查没有意义（该字段最大只有 9999）。
- **缺陷 17 — 0 起始 Modicon 编号只实现了一半。** 机制是客户端构造函数选项
  `options.modicon_zero_based`（默认 `false`；`true` 选择 0 起始的 Modicon 编号，此时 PDU 地址
  等于点号）。代码里目前仍叫 `zero_based`，需要改名。机制的位置是对的，但：
  - `parse_address` 拒绝点号 `0` 且不考虑起点，因此 0 起始模式下第一个点（`"40000"`、
    `"400000"`）无法寻址，缺陷 16 中的范围也没有被遵守。
  - 该选项的含义必须收窄为只作用于 Modicon 字符串：不得影响结构化 PDU 地址，后者永远是 0 起始
    且从不转换。
- **缺陷 18 — `parse_address(address_str)` 结构不好。** 除缺陷 16 之外：
  - 它对非字符串返回 `null`，因此数组和对象形式会以 `Invalid address format` 失败；“客户端地址
    参数”中描述的按类型分流尚未实现（缺陷 19）。
  - 它把三件事混在一起：解析字符串、校验点号范围、把表的数字映射成功能码。
- **缺陷 19 — `read()` / `write()` 只接受 Modicon 字符串。** 数组形式
  `[func_code, pdu_addr, length]` 和对象形式 `{ func_code, pdu_addr, length }`（见“客户端地址
  参数”）都没有实现，其字段的校验也没有实现（`func_code` 为 `1, 2, 3, 4, 5, 6, 15, 16` 之一的
  `number`，`pdu_addr` 为 `0..65535` 的整数，`length` 为 `>= 1` 的整数，且 FC 5 和 6 时恰为 `1`）。
  针对 Modicon 字符串的参数校验（单元 ID、数量上限、写入值）已经就位。
- **缺陷 20 — `MB_prefix_dict` 无法解析功能码。** 结构化形式需要一个从 `func_code` 到表类型和
  读/写方向的查找。`MB_prefix_dict` 的键是 Modicon 前缀数字（`'0'` 线圈、`'1'` 离散输入、`'4'`
  保持、`'3'` 输入），而不是功能码，因此用 `func_code - 1` 去索引会得到错误或缺失的结果：FC 3 →
  `'2'`（缺失，保持寄存器是 `'4'`），FC 5 → `'4'`（保持寄存器，但 FC 5 写的是线圈），FC 6 →
  `'5'`（缺失），FC 15 → `'14'`（缺失）。需要在它旁边增加一个按功能码查找的结构（表，或按功能码
  索引的数组）。
- **缺陷 21 — 连接丢失时不拒绝待决请求，且过期的帧仍留在队列中*（已验证）*。** spec 要求连接
  丢失时立即拒绝每个待决请求并丢弃排队的帧。代码两件事都没做：待决请求只是等待自己的超时；客户端
  断开或处于退避期间超时的请求，其帧仍留在 `send_queue` 中。连接恢复后，下一次 `send()` 会把它
  发出去，因此调用者已被告知失败的写入仍可能被延迟执行。拒绝的值应为
  `new Error('connection lost')`，重连退避期间发出的请求应被立即拒绝；目前 `sending()` 只发出
  `error`，并把帧留在队列中。
- **缺陷 26 — 服务端不捕获抛出异常的 `vector`。** spec 要求记录该错误并返回异常 `0x04`。
  `vector` 的调用没有被包裹，因此异常会作为未捕获异常逃出套接字 `data` 处理器，对端得不到任何
  响应。（由代码推出。）
- **缺陷 27 — `unit_id` `0` 仍表示“接受所有单元 ID”，广播也没有被处理。** spec 把两者分开：
  只有 `null`、`undefined`、`'all'`、`'*'` 表示接受所有 ID（默认值），`0` 是广播地址，广播会执行
  写入、忽略读取，且从不应答。代码仍把 `0` 保留为“全部”的别名（并把 `options.unit_id` 默认为
  `0`），对发往单元 `0` 的请求与其他请求一样应答。JSDoc 已按 spec 描述，代码尚未跟上。这是对
  `set_unit_ids` 的破坏性改动。
- **缺陷 28 — 奇数长度的寄存器 `Buffer` 抛出的错误不对*（已验证）*。** 对
  `write('40001', Buffer.alloc(3))`，长度按 `value.length / 2 = 1.5` 推出；缓冲区长度检查
  `value.length !== length * 2` 得以通过，随后 `check_quantity` 抛出
  `Invalid length 1.5 for function code 16`。spec 要求的是
  `Invalid buffer length for register write`。它仍然是同步抛出。

---

## 待决问题

spec 尚未做出的决定。先在 spec 中定下来，再去实现。

- **串口参数。** 服务端 `string` 类型的 `port` 被传给 `new SerialPort(port)`，但 `serialport` 需要
  一个选项对象（路径、波特率、校验位……）。除了直接传入现成的 `SerialPort` 实例，spec 没有定义
  给出串口参数的方法。
- **不完整的 TCP 帧。** 对 TCP，spec 只要求拆分被合并的帧（对 RTU-over-TCP 则要求按长度界定）。
  代码还会丢弃末尾不完整的帧，而不是缓冲到下一次读取（客户端的 `unprocessed_buffer` 字段未被
  使用）。需要决定 TCP 是否也要求缓冲。
- **服务端的上限与异常码。** 客户端一侧已定：超限的长度会抛出异常。对服务端，需要决定超范围的
  数量是否应答 `0x03`（非法数据值）、超范围的地址是否应答 `0x02`，等等（见缺陷 13）。
- **服务端如何记录 `vector` 的错误。** spec 规定要记录该错误。需要决定机制：专用事件、现有的
  `error` 事件（无人监听时会抛出），或可注入的 logger。
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
- **`write()` 的返回值。** 需要决定它以 `Buffer`（spec 现状）还是以回显的值（代码现状）兑现；见
  缺陷 10。
- **串行总线上的单元 ID 不匹配。** spec 规定，发往未被接受单元 ID 的请求，在所有传输方式上都得到
  异常 `0x0B`。在共享的 RTU 总线上，其他从站会应答同一个请求，因此通常的做法是保持沉默。需要决定
  RTU 服务端是应答 `0x0B`（spec 现状），还是保持沉默。
- **`disconnect()` 与自动重连。** `disconnect()` 结束套接字，随后 `close` 事件会触发重连定时器，
  因此 `reconnect_time > 0` 时，显式 `disconnect()` 之后客户端会自行重连（这是按字面遵循 spec 的
  重连规则）。需要决定显式 `disconnect()` 是否应抑制重连。
