# 设计

> 本文是 [design.md](design.md) 的中文译本。

本库**如何**构建：内部机制、实现现状、已知缺陷和待办事项。行为约定见 `spec-*` 系列；本文记录
实现及粗糙之处，以便后续改动时心中有数。目前这是唯一的设计文档；内容变多后再拆分为
`design-<topic>.md`。

## 传输方式选择

- **客户端。** 构造函数设置 `this.protocol`：`tcp`、`rtu_over_tcp`（字符串地址且 `rtu: true`）
  或 `rtu`（非字符串地址）。对 `rtu`，先用 `serial_settings` 校验串口选项，再以结果调用
  `set_serial`；串口在之后才创建。
- **解码。** 响应解码**仅**按 `protocol === 'tcp'` 分支，因此 `rtu_over_tcp` 使用 RTU 解析器
  （`parse_rtu_response`）解码。
- **服务端。** 构造函数原样保存 `port`：`number`（TCP）或 `string` 设备路径；后者的选项由
  `serial_settings` 校验后存入 `this.serial_settings`；其他值抛出异常。构造函数按与客户端相同的
  取值设置 `this.protocol`：`tcp`、`rtu_over_tcp`（数字端口且 `rtu: true`）或 `rtu`（字符串端口，
  忽略 `rtu`）。`is_tcp` 是一个 getter：`typeof this.port === 'number'`，对两种 TCP 系列传输都为真。串口是 `this.serial_port`，由首次 `start()` 创建
  （`start_serial`：共用同一个待决的创建，失败时将其重置，使之后的 `start()` 重试）；
  `send_response` 和 `stop` 使用它。
- **`src/serial.js`。** `serial_settings` 校验 snake_case 选项，并转换为 `serialport` 的参数
  （`port` → `path`，`baud_rate` → `baudRate`，`parity` 中 `0`/`1`/`2` 映射为 `none`/`odd`/`even`，
  `data_bits` → `dataBits`，`stop_bits` → `stopBits`）。`create_serial_port` 以
  `@serialport/bindings-cpp` 的 `autoDetect()` 绑定和 `autoOpen: false` 创建一个未打开的
  `SerialPortStream`（`@serialport/stream`）。它通过动态 `import()` 引用这两个包，绝不静态导入：
  Rolldown 会把对 CommonJS 包的静态导入变成顶层的 `require`，在导入时就执行并加载原生绑定；动态
  导入则变成同一文件内延迟执行的 `require`（`codeSplitting: false`）。只导入这两个包而不导入
  `serialport`，可以把用不到的 parser 排除在打包产物之外。`set_serial_port_factory` 供测试替换工厂。
- **客户端串口生命周期。** `set_serial` 为 `_open` 赋值：它只创建一次串口（创建失败会被遗忘，
  下次尝试会重试），挂接串口事件（`listen_serial`），并打开它（并发调用者共用一次尝试）。失败时执行 `abort_pending()` 并发出 `error`。连接阶段跟随串口的 `open` / `close` /
  `error` 事件（见“客户端连接状态”）。串口绝不进入 `BACKING_OFF`：关闭后转入 `IDLE`，已关闭的
  串口只会按需重新打开。

## 构建（`build.js`）

- 用 Rolldown API 把 `src/index.js` 打包为单个 ES 模块 `dist/modbus.js`。`transform.define` 把
  `__dirname` 替换为 `import.meta.dirname`：绑定以 `path.join(__dirname, "../")` 查找预编译文件，
  而 ES 模块没有 `__dirname`。因此打包产物在 `dist/../prebuilds`（即包根目录）处找到它们。打包代码
  中只有这一处 `__dirname`，替换不会影响其他代码。
- 用 `@serialport/bindings-cpp` 的 `prebuilds/` 原样替换 `prebuilds/`：`node-gyp-build` 会选择
  `prebuilds/<平台>-<架构>/`，在 Linux 上再按 glibc 或 musl 选择文件。
- 依据打包产物的模块 ID 生成 `THIRD_PARTY_LICENSES`：列出产物中每个来自 `node_modules` 的包的
  名称、版本、许可证和许可证文件，许可证文本相同的包共用一项。原生预编译文件属于
  `@serialport/bindings-cpp`，它也在其中。
- 用户若再次打包 es-modbus，`import.meta.dirname` 会变成其自身产物的目录；他们需要把
  `prebuilds/` 复制到产物旁边，或把 es-modbus 设为 external。

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
  为 256。只有 TCP 使用它：RTU 系列最多只有一个已写出的请求，从帧写出到请求结束都保存在
  `#current` 中。
- **TID 分配（`get_tid`）。** 非 TCP 始终返回 `TRANSACTION_START`（RTU 没有事务字段）。TCP
  则递增 `#last_tid`，一旦超过 `packets_length + TRANSACTION_START` 就回绕到
  `TRANSACTION_START`。由于只有 256 个槽位，且不检查槽位是否空闲，同时待决的 TCP 事务超过
  256 个就会冲突。
- **`process_packet_transaction`。** 处于 `BACKING_OFF`、`DISCONNECTING` 或 `DISCONNECTED` 时，
  它返回一个已以 `Error('connection lost')` 拒绝的 Promise；帧从不入队。仅在 `BACKING_OFF` 时它
  同时发出 `error`，且仅当客户端有 `error` 监听者时：没有监听者时发出 `error` 会抛出异常，而参数
  合法的调用不得同步抛出。
  否则设置 `status = 'pending'`，递增 `#trans_count`，创建 Promise，再将 packet 入队并返回该
  Promise。它把 `resolve` / `reject` / `on_timeout` 闭包存放在 packet 上；定时器（`timeout_id`）
  由 `#write` 在帧写出时启动，因此排队时间不计入超时。`end_transaction` 递减计数，标记 `status`，
  清除定时器，把 `resolve`/`reject` 换成 `DO_NOTHING` 使迟到/重复的响应无效，并调用
  `#transaction_ended`。RTU 超时还会清空 `unprocessed_buffer`，以免迟到应答的字节混到下一个响应
  前面。
- **界定（`on_data`）。** 数据块追加到 `unprocessed_buffer`，再用 `split_frames` 切分：`tcp` 用
  `mbap_frame_length`，否则用 `rtu_response_length`。`#keep` 把 `rest` 存入 `unprocessed_buffer`，
  不为空时重设 `#silence_timer`（`#silence`，见下文“静默”）。`#on_silence` 对残留字节调用 `resync_frames`，仍然剩下的字节在 TCP 上保留
  （不再重设定时器），在串口上丢弃。`#transport_opened` 和 `#transport_lost` 会清空缓冲区。响应
  的帧长不会是 `UNKNOWN`，所以客户端没有帧长未知的情况。
- **匹配（`on_data`）。** 对每一帧：解析 → 发出 `receive` → 跳过 `func_code === 0` → 按 `tid`
  查找（TCP）或取 `#current`（RTU 系列）→ 除非 `status === 'pending'` 否则忽略 → RTU 系列上，
  除非 `response_fits()`（单元 ID 相同、去掉异常位后功能码相同，读还要求字节数与所请求的相符）
  否则忽略 → 有 `exception_code` 则 `reject`，否则兑现：读以 `response.data` 兑现，写以
  `echo_matches()` 的结果兑现。TCP 不检查 `response_fits()`：事务 ID 已经匹配，而且有些网关会以
  别的单元 ID 应答。
- **写回显。** `transact()` 保存 `packet.echo`，即写响应在地址之后必须回显的值（`expected_echo()`：
  FC 5 为 `0xFF00` / `0x0000`，FC 6 为值，FC 15/16 为数量；读为 `undefined`）。`echo_matches()` 把响应的
  功能码、单元 ID、起始地址以及回显的值或数量与请求比较；写以比较结果兑现。

## 发送队列 / 背压（`send` → `sending`）

- `send_queue` 是 packet 的数组，上限为 `send_queue_size`（256）；溢出时从**队首**切除（丢弃最旧
  的），并以 `Error('queue overflow')` 拒绝每个被丢弃的 packet。由于定时器在写出时才启动，被丢弃
  而不拒绝的 packet 将永远不会结束。
- `sending` 由 `#busy` 保护，队列为空时立即返回。已连接时，它设置 `#busy`，取出一个 packet 交给
  `#write`，后者启动超时并调用 `_send`。`#release(gap)` 在 `gap` 毫秒后清除 `#busy` 并重新进入。
  `#gap` 为 `delay`，串口上为 `max(delay, silence)`。
  - **TCP：** `#write` 写出后立即调用 `#release(#gap)`，因此写入受节流，但可以有多个未完成的请求。
  - **RTU 系列：** `#write` 把 packet 存入 `#current`，不释放；`end_transaction` 调用
    `#transaction_ended`，后者清空 `#current` 并调用 `#release(#gap)`。因此下一帧在请求结束（响应、
    异常、超时或 `abort_pending()`）之后才写出；每个已写出的请求都会结束，所以 `#busy` 不会一直
    保持。
  - **广播**（`packet.broadcast`：非 TCP 协议上发往单元 `0` 的任何请求）：不会有应答，因此
    `#write` 在 `_send` 之后立即兑现它（写以 `true`，读以空 `Buffer`），不启动定时器，并调用
    `#release(max(turnaround, #gap))`。
- 处于 `IDLE`（或加入进行中的 `CONNECTING`）时，`sending` 以自身作为成功回调发起连接。它绝不从其他阶段发起连接：退避
  或手动关闭都在 `abort_pending()` 清空队列之后才开始，而此时发出的请求在入队之前就被拒绝。
- **`abort_pending()`。** 清空 `send_queue`，并以 `Error('connection lost')` 拒绝每个 `status` 为
  `'pending'` 的 packet：排队的，以及已写出的（TCP 上为 `#packets`，RTU 系列上为 `#current`）。它在每次传输层 `close` / `error`（经由 `#transport_lost`，TCP 套接字和
  串口）时运行，也在从 `IDLE` 或 `BACKING_OFF` 调用 `disconnect()` 时运行，因此按需连接失败时，其
  请求也会立即失败。

## 客户端连接状态

### 阶段

连接恰好处于六个阶段之一，保存在一个私有整数 `#state` 中。设置阶段只需一次赋值，因此不可能有
两个阶段同时为真，也无需复位任何东西。阶段常量位于模块级的冻结对象
`STATE = Object.freeze({ IDLE, CONNECTING, CONNECTED, DISCONNECTING, DISCONNECTED, BACKING_OFF })`。

| `#state`        | 只读 getter        | 含义                                                |
| --------------- | ------------------ | --------------------------------------------------- |
| `IDLE`          | `is_idle`          | 未连接；允许自动连接和按需连接。                    |
| `CONNECTING`    | `is_connecting`    | 连接（TCP）或打开（串口）进行中。                   |
| `CONNECTED`     | `is_connected`     | 传输已连通。                                        |
| `DISCONNECTING` | `is_disconnecting` | 已调用 `disconnect()`，传输尚未关闭。               |
| `DISCONNECTED`  | `is_disconnected`  | 由 `disconnect()` 关闭；只有 `connect()` 能离开它。 |
| `BACKING_OFF`   | `is_backing_off`   | 连接已丢失，重连定时器在等待。                      |

类中其余代码只通过这些 getter 读取阶段：除 getter 外没有代码直接比较 `#state`。
`enable_reconnect`（见 `spec-client.zh-cn.md`）也是 getter：`!(is_disconnecting || is_disconnected)`。

`IDLE` 和 `DISCONNECTED` 都是“未连接，也没有进行中的操作”。二者只在“下一次由谁连接”上不同：
任何途径（`IDLE`），或只有 `connect()`（`DISCONNECTED`）。命名遵循客户端自己的词汇：`connect` →
`CONNECTING` → `CONNECTED`，`disconnect` → `DISCONNECTING` → `DISCONNECTED`，而不用传输层的
`close`。

### 转移

| 起始阶段                   | 触发                                                      | 目标阶段        |
| -------------------------- | --------------------------------------------------------- | --------------- |
| （构造）                   | —                                                         | `IDLE`          |
| `IDLE`                     | `reconnect_time > 0` 时的构造；`sending` 的按需连接；`connect()` | `CONNECTING` |
| `DISCONNECTED`             | `connect()`                                               | `CONNECTING`    |
| `BACKING_OFF`              | 重连定时器触发                                            | `CONNECTING`    |
| `CONNECTING`               | 传输的 `connect` / `open`                                 | `CONNECTED`     |
| `CONNECTING` / `CONNECTED` | 传输的 `close` / `error`，TCP 系列且 `reconnect_time > 0` | `BACKING_OFF`   |
| `CONNECTING` / `CONNECTED` | 传输的 `close` / `error`，其他情况（串口，或 `reconnect_time = 0`） | `IDLE` |
| `CONNECTING` / `CONNECTED` | `disconnect()`                                            | `DISCONNECTING` |
| `DISCONNECTING`            | 传输的 `close`（或 `error`）                              | `DISCONNECTED`；若有 `connect()` 在等待，随即 `CONNECTING` |
| `IDLE` / `BACKING_OFF`     | `disconnect()`（退避时取消定时器）                        | `DISCONNECTED`  |

表中没有的触发不改变阶段：`CONNECTING` 时调用 `connect()` 加入进行中的尝试；`CONNECTED` 时调用
`connect()` 立即兑现；`BACKING_OFF` 时调用 `connect()` 以 `ERR_ILLEGAL_STATE` 拒绝；
`DISCONNECTING` 时调用 `disconnect()` 共用进行中的关闭；`DISCONNECTED` 时调用 `disconnect()` 立即
兑现。

### 规则

- **每次丢失由一个事件转移阶段。** 传输层向 `#transport_opened()` 和
  `#transport_lost(error, emit_disconnect)` 报告；后者运行 `abort_pending()`，且只从
  `CONNECTING`、`CONNECTED` 或 `DISCONNECTING` 转移阶段，因此重复的报告不做改变。各传输保证一次
  丢失只报告一次：
  - **TCP。** 套接字在每次 `error` 之后都会发出 `close`，因此只由 `close` 报告丢失；`error` 只
    保存错误（供连接失败时的调用者使用）并发出它。若在 `error` 上转移，随后的 `close` 可能被当作
    更新一次尝试的丢失。这取代了原先靠 `_conn_failed` 去重的做法。
  - **串口。** 串口可能只发出 `error` 而之后没有 `close`。串口仍打开时的 `error` 会关闭串口，由
    其 `close` 报告丢失；串口已关闭时的 `error` 立即报告。这是串口代码唯一读取 `isOpen` 的地方。
- **重连定时器。** `#reconnect_timer` 保存待决定时器的句柄。它是资源，不是阶段：恰好在
  `BACKING_OFF` 期间不为空。进入 `BACKING_OFF` 时启动它；定时器回调先清除它，再转入
  `CONNECTING`；`disconnect()` 用 `clearTimeout` 清除它。
- **等待中的 `connect()`。** `DISCONNECTING` 期间调用的 `connect()` 被保存为一个待决的兑现函数，
  同样是资源而不是阶段。结束 `DISCONNECTING` 的 `close` 启动它。在此之前调用 `disconnect()` 会
  以 `connection lost` 拒绝它。
- **请求。** 处于 `BACKING_OFF`、`DISCONNECTING` 或 `DISCONNECTED` 时，`process_packet_transaction`
  立即以 `connection lost` 拒绝请求。只有 `BACKING_OFF` 时才发出 `error`（有监听者时）：另外两种
  情况是调用者自己关闭了连接。处于 `IDLE` 时请求入队，由 `sending` 按需连接；其他阶段绝不按需连接。
- **关闭传输。** 从 `CONNECTING` 或 `CONNECTED` 调用 `disconnect()` 时调用传输层的 `_close()`。
  TCP 销毁套接字（`socket.destroy()`），而不是 `end()`：链路已断时对端的 FIN 永远不会到来，关闭
  会一直挂起。串口则关闭串口；串口的打开无法中止，因此从 `CONNECTING` 调用时，在打开有结果后立即
  关闭串口，若打开失败则由失败自行报告丢失。`disconnect()` 的 Promise 在转入
  `DISCONNECTED` 时兑现，晚于 `disconnect` 事件。从 `IDLE` 或 `BACKING_OFF` 调用时不会再有传输
  事件，因此 `disconnect()` 自行运行 `abort_pending()` 并立即兑现。
- **`#busy` 不是阶段。** 它标记一次帧写入正在进行：直到写出之后（TCP）或请求结束之后（RTU 系列）
  的间隔过去为止。它与连接阶段无关，因此仍是独立的布尔值。

### 传输钩子

每种传输为 `_send(data)`、`_open()` 和 `_close()` 赋值。`_open()` 只在转入 `CONNECTING` 时
调用；在 `CONNECTING` 期间到来的调用者被加入 `#connect_waiters`，因此并发调用者共用一次尝试。

- **TCP（`set_tcp`）。** `_open()` 即 `socket.connect`；套接字的 `connect` 事件报告
  `#transport_opened()`。每次尝试都复用同一个套接字。
- **串口（`set_serial`）。** `_open()` 只创建一次串口（`creating` Promise，是懒创建缓存，不是
  阶段）并打开它；`opening` Promise 让 `_close()` 能等待进行中的打开。由打开的回调（而不是 `open`
  事件）报告 `#transport_opened()`。

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
- **界定与解析分开。** 帧长函数（`mbap_frame_length`、`rtu_request_length`、
  `rtu_response_length`）读取缓冲区开头，返回帧长或 `NEED_MORE` / `INVALID` / `UNKNOWN`（导出的
  常量），规则见 `spec-protocol.zh-cn.md` 的“帧的界定”中的表。只要决定帧长的字节已经到齐，它们
  就返回帧长；缓冲区是否够长由调用方比较。RTU 整帧到齐后，它们还会校验 CRC（`rtu_length`），
  不对就返回 `INVALID`；因此帧长 > 0 且字节足够，就一定是一个完整、有效的帧。
- **`split_frames(buffer, frame_length)`** 是纯函数，返回 `{ frames, rest }`；`rest` 由调用方持有，
  下次与新数据块合并后再传入。从 `pos` 开始循环：完整的帧被切出；`INVALID` 时调用
  `resynchronize`（`pos` 之后第一个帧长 > 0 且字节足够的偏移；`UNKNOWN` 的偏移不算），找不到就把
  `pos` 前移一个字节；一旦某次查找一无所获，同一次调用里后面的查找都跳过（`none_follows`），因为
  更靠后的 `pos` 之后同样没有。遇到 `NEED_MORE`、`UNKNOWN` 或字节不够时停止循环。只有一个数据块时
  直接使用，不复制。
- **`resync_frames(rest, frame_length)`** 由静默定时器调用：从 `rest` 开头之后的第一个完整帧处
  重新界定（从 0 开始 `resynchronize`），找不到就原样返回 `rest`。查找在任何时刻进行都是安全的：
  字节流是有序的，一个正确的帧还没收全时，它后面不可能出现完整的帧。不需要单独的长度上限：帧长
  函数的结果不会超过最大 ADU，所以 `rest` 总是短于一个最大 ADU。一次重新同步对几百个字节的每个
  偏移至多算一次 CRC，而且只在出错，或有残留字节时静默之后才进行。
- **静默。** 两个构造函数都用 `silence_option`（`util.js`）读取 `silence` 选项：为空时取
  `DEFAULT_SILENCE_MS`（50），否则必须是有限的正数，否则抛出 `Invalid silence`。TCP 系列传输直接
  使用该值；串口使用 `silence_time(settings, silence)`（`serial.js`），即 `max(t3.5, silence)`，
  其中 t3.5 为 3.5 个字符时间，19200 波特以上为 1.75 ms。结果存为 `#silence`。
- 四个解析器（`parse_tcp_request` / `_response`、`parse_rtu_request` / `_response`）都只解析
  **一个**已界定的帧，返回一个对象。它们仍然校验 PDU 布局和 CRC，因为帧长未知的请求是以已收到的
  字节整体交给它们的。
- `modbus_crc16(bytes, previous?)` 采用查表实现（256 项 `Int32Array`）；`previous` 允许跨数据块
  增量计算。
- RTU 解析器合成 `tid = TRANSACTION_START`（8000，因为 RTU 没有事务字段），校验 PDU 长度（`3..253`），校验各 FC 的字节布局，
  然后验证 CRC — 任何失败都归结为 `{ tid, func_code: 0, buffer }`。
- 请求解析器对功能码不受支持但在 `1..127` 之内的帧设置 `illegal_function`（同时 `func_code: 0`）；
  对 RTU，仅当整个缓冲区的 CRC 有效时才设置。其他任何失败都使其为 `undefined`。
- 响应解析器把 `func_code > 127` 且 PDU 为 3 字节的情形视为异常并读取异常码字节；其他无法识别
  的情形变为 `func_code: 0`。

## 服务端分发说明

- 帧格式取决于 `this.protocol`：`on_data` 据此选择解析器，`send_response` 据此组帧，`_on_data`
  据此确定串行总线语义。`socket` 参数只表示响应写到哪里：两种 TCP 系列传输写入套接字，没有
  `socket` 时写入串口。
- `handle_read_bits` 服务 FC 1 和 FC 2；`handle_read_registers` 服务 FC 3（保持）和 FC 4（输入），
  通过 `function_code === 3` 分支。

### 请求流程

1. `on_data(chunk, socket?)` — 把数据块追加到该 socket 的残留字节（`#pending`，以 socket 为键的
   `Map`；串口的以 `undefined` 为键），再用 `split_frames` 切分（`tcp` 用 `mbap_frame_length`，
   否则用 `rtu_request_length`）。在 `rtu_over_tcp` 上，帧长为 `UNKNOWN` 的 `rest` 立即作为一帧
   （`take_unknown`）。`#keep` 保存剩下的字节，不为空时重设它在 `#silence_timers` 中的定时器
   （`#silence`，见编解码说明中的“静默”）；socket 的这两项
   在其 `close` 时清除，串口的在串口 `close` 时清除。`#on_silence`：串口上帧长为 `UNKNOWN` 的
   `rest` 作为一帧，否则调用 `resync_frames`，RTU 上再调用 `take_unknown`；仍然剩下的字节在串口上
   丢弃，在 TCP 上保留，不再重设定时器。
   每一帧交给 `#on_frame`：`tcp` 时用 `parse_tcp_request` 解析，否则用
   `parse_rtu_request`，然后发出 `receive`。`func_code: 0` 的帧被丢弃，除非解析器设置了
   `illegal_function`；此时以该功能码继续处理。
2. `_on_data(request, socket?)` — RTU 帧格式（`rtu` 和 `rtu_over_tcp`）时 `serial_bus` 为真。在串行总线上，广播（单元 `0`）从不应答：若单元 `0` 被接受且功能为写
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
3. `send_response(pdu, socket?, tid, pid)` — `tcp`：前置新的 MBAP 头。`rtu` 和 `rtu_over_tcp`：
   追加 CRC-16（小端）。发出 `send`，然后写入 `socket`；没有 `socket` 时写入串口。

---

## RTU / 串口：未完成的工作

**状态：未完成。** 目前只有 Modbus TCP 是完整的。`rtu`（串口）和 `rtu_over_tcp` 属于范围之内
（见 `spec.zh-cn.md`），但必须视为不受支持。部分代码已存在：`src/util.js` 中的编解码
（`parse_rtu_request`、`parse_rtu_response`、`modbus_crc16`）、`make_data_packet` 的客户端 RTU
分支、`Modbus_Client.set_serial` 和 `Modbus_Server.set_rtu`。它们尚未完成，也没有端到端地跑通过。
本节即待办清单；只有当某项在代码中真正修复后才能删除它。`spec-*` 文件描述的是目标约定，因此其中与 RTU / 串口
相关的行目前并不由代码保证，且清单清空时它们也不需要改动。

每一项都是缺陷或缺失的部分，而不是预期行为。

### 服务端

- [ ] **串口路径未经端到端验证。** `test/serial.test.js` 通过一对串口测试 RTU 服务端和客户端，
  但在开发机上 com0com 端口对未通过套件的预检，串口测试被跳过（见 `spec-test.zh-cn.md`
  “串口测试环境”）。客户端和服务端的串口路径改由模拟串行线路 `test/serial-bridge.js`（用法见该文件
  开头）来测试，线路另一端接 RTU-over-TCP 对端或原始套接字；尚未验证的是 `serialport` 配合真实驱动和
  硬件的情况。
