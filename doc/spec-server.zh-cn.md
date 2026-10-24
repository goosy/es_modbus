# Modbus_Server

> 本文是 [spec-server.md](spec-server.md) 的中文译本。

从站/服务端。`extends EventEmitter`。

## 构造

```js
import { Modbus_Server } from 'es-modbus';

const server = new Modbus_Server(handler, options);
await server.start();
```

### options

| 选项      | 默认值      | 含义                                                                          |
| --------- | ----------- | ----------------------------------------------------------------------------- |
| `name`    | `'Modbus_Server'` | 用于区分实例的名称，例如在日志中；保存在 `name` 属性中。库本身不使用它。 |
| `host`    | `'0.0.0.0'` | 绑定地址（仅 TCP）。                                                          |
| `port`    | `502`       | `number` → 监听该 TCP 端口。`string` → 作为串口设备路径打开。其他值抛出 `Invalid port`；不接受串口实例。 |
| `rtu`     | `false`     | `port` 为 `number` 时，在接受的 TCP 套接字上使用 RTU 帧格式（RTU-over-TCP）。串口忽略此项。 |
| `silence` | `50`        | 静默时间（ms），超过之后处理不完整帧留下的残留字节（见 `spec-protocol.zh-cn.md` 的“帧的界定”）。必须是有限的正数（否则抛出 `Invalid silence`）。串口上至少为 3.5 个字符时间（19200 波特以上为 1.75 ms）。 |
| `unit_id` | 全部        | 应答哪些 Modbus 单元 ID；省略时为所有 ID（见 `set_unit_ids`）。              |
| `baud_rate` | `9600`    | 串口波特率，正整数（否则抛出 `Invalid baud rate`）。 |
| `parity`  | `'none'`    | 串口校验位：`'none'`、`'odd'`、`'even'`，或 `0` = 无、`1` = 奇、`2` = 偶。其他值抛出 `Invalid parity`。 |
| `data_bits` | `8`       | 串口数据位：`5`、`6`、`7` 或 `8`（否则抛出 `Invalid data bits`）。 |
| `stop_bits` | `1`       | 串口停止位：`1`、`1.5` 或 `2`（否则抛出 `Invalid stop bits`）。 |

串口选项（`baud_rate`、`parity`、`data_bits`、`stop_bits`）只在 `port` 为串口设备路径时生效，对 TCP
端口会被忽略。它们在构造时校验，无效时构造函数抛出异常；串口本身由 `start()` 创建并打开。

### 传输方式选择

服务端的传输方式在构造时由 `port` 和 `rtu` 决定：

| `port`                        | `rtu`   | 传输方式       | 行为                                                            |
| ----------------------------- | ------- | -------------- | --------------------------------------------------------------- |
| `number`                      | `false` | TCP            | 监听 `host:port`；每个连接使用带 MBAP 的 Modbus TCP 帧格式。     |
| `number`                      | `true`  | RTU-over-TCP   | 监听 `host:port`；每个连接使用 RTU 帧（单元 ID + PDU + CRC16）。 |
| `string`                      | 忽略    | RTU            | 打开串口，作为 Modbus RTU 从站应答。                             |

RTU 服务端就是串行线路上的 Modbus 从站：它没有连接，并以 CRC-16 封装响应。三种传输方式的请求
处理（单元 ID 路由、`handler`、异常响应）完全相同；只有帧格式和生命周期事件不同。

### `set_unit_ids(unit_id)`

- `null`、`undefined`、`'all'`、`'*'` → 接受**所有**单元 ID（0–255）。这是默认值。
- `number` → 仅接受该 ID。这里的 `0` 是普通 ID（在串行总线上是广播地址），不是“所有 ID”的同义词。
- 数字数组 → 恰好接受这些 ID。
- 任何超出 `0..255` 的 ID（包括非整数）都会抛出异常。

单元 ID 的行为取决于传输方式（见 `spec-protocol.zh-cn.md` 的“单元 ID”）：

- **TCP。** 每个单元 ID（包括 `0`）都是普通单元。发往被接受单元的请求经 `handler` 处理；发往未被
  接受单元的请求得到代码为 `0x0B` 的异常响应。
- **串行总线（RTU、RTU-over-TCP）。** 服务端是共享线路上的一个从站，因此发往未被接受单元 ID 的
  请求完全不应答。发往单元 `0` 的请求是广播：如果单元 `0` 被接受（显式接受，或因为接受所有 ID），
  写请求会被执行，读请求会被忽略。无论单元 `0` 是否被接受，广播都不会得到应答。

## `handler` 接口

服务端本身不持有数据。每个请求都通过调用下列由调用者提供的函数之一来处理（名称为
`snake_case`）。传入的地址是 **PDU 地址**：线路上的**原始（0 起始）**值，类型为 `number`，绝不是
Modicon 表示法（服务端只使用 PDU 地址）。始终会提供 `unit_id`，因此同一个 `handler` 可以支撑多个
单元。

| 方法                                              | 用于                            | 返回值             |
| ------------------------------------------------- | ------------------------------- | ------------------ |
| `get_coil(addr, unit_id)`                         | FC 1（线圈）；FC 2 的回退       | 真值 = 位已置位 |
| `get_discrete_input(addr, unit_id)`               | FC 2（离散输入，可选）          | 真值 = 位已置位 |
| `get_holding_register(addr, unit_id)`             | FC 3                            | `0..65535` 的整数  |
| `get_input_register(addr, unit_id)`               | FC 4                            | `0..65535` 的整数  |
| `set_coil(addr, value, unit_id)`                  | FC 5、FC 15                     | 忽略               |
| `set_holding_register(addr, value, unit_id)`      | FC 6、FC 16                     | 忽略               |
| `get_coils(addr, quantity, unit_id)`              | FC 1（可选）；FC 2 的回退       | `quantity` 个值，真值 = 位已置位 |
| `get_discrete_inputs(addr, quantity, unit_id)`    | FC 2（可选）                    | `quantity` 个值，真值 = 位已置位 |
| `get_holding_registers(addr, quantity, unit_id)`  | FC 3（可选）                    | `quantity` 个 `0..65535` 的整数 |
| `get_input_registers(addr, quantity, unit_id)`    | FC 4（可选）                    | `quantity` 个 `0..65535` 的整数 |
| `set_coils(addr, values, unit_id)`                | FC 15（可选）                   | 忽略               |
| `set_holding_registers(addr, values, unit_id)`    | FC 16（可选）                   | 忽略               |

Modbus 中只有线圈和保持寄存器可写，所以写方法不涉及其他表。

参数类型：`addr`、`quantity` 和 `unit_id` 是 `number`；`set_coil` 的 `value` 是 `boolean`；
`set_holding_register` 的 `value` 是 `0..65535` 范围内的整数。`set_coils` 的 `values` 是
`boolean` 的 `Array`；`set_holding_registers` 的 `values` 是 `0..65535` 范围内整数的 `Array`。
`values[i]` 是地址 `addr + i` 的值，`values.length` 即请求的数量。每次调用都传入新数组，
`handler` 可以保留它。

成批读方法返回恰好 `quantity` 个值的 `Array` 或类型化数组（例如 `Uint16Array`），`values[i]`
是地址 `addr + i` 的值。服务端在再次调用该方法之前就读完它；`handler` 可以返回自身存储的视图。

**成批方法。** 六个成批方法（`get_coils`、`get_discrete_inputs`、`get_holding_registers`、
`get_input_registers`、`set_coils`、`set_holding_registers`）是可选的。它们让 `handler` 把一个请求的各个点作为一个
整体处理：

- **成批写，一致性**：一步更新一个占多个寄存器的值，而不是让它以写了一半的状态暴露出来。
- **成批写，性能**：定位数据、检测变化、通知订阅者等工作每个请求只做一次，而不是每个点做一次。
- **成批读**：每次读取都有副作用（诊断事件、访问计数、按需刷新）的数据源，每个请求只产生一次
  副作用，而不是每个点一次；一个请求也可以变成对数据源的一次范围读取。一致性不是这里的理由：
  `handler` 是同步的，逐点读取看到的已经是同一个快照。

规则如下：

- 若 `handler` 有请求对应的成批方法，以请求的全部点调用一次；否则按地址升序对每个点各调用一次
  单点方法。FC 1 用 `get_coils` / `get_coil`，FC 2 用 `get_discrete_inputs` / `get_discrete_input`
  （见下文“离散输入”），FC 3 用 `get_holding_registers` /
  `get_holding_register`，FC 4 用 `get_input_registers` / `get_input_register`，FC 15 用
  `set_coils` / `set_coil`，FC 16 用 `set_holding_registers` / `set_holding_register`。
- 按功能码而不是按数量选择：只涉及一个点的请求，有成批方法时仍调用成批方法。FC 5 和 FC 6
  始终调用 `set_coil` 和 `set_holding_register`。
- 各成批方法相互独立：`handler` 可以提供其中任意几个。
- 每个请求在被处理时各自选择。
- 与其他 `handler` 函数一样，成批方法只对有效请求调用；它抛出异常时也同样处理（`handler_error`、
  异常 `0x04`）。没有成批方法时，某次 `set_coil` / `set_holding_register` 抛出异常即终止该
  请求：它之前的点已写入，其余的点不再写入。
- 成批读的结果不是 `Array` 或类型化数组，或长度不等于 `quantity` 时，按抛出异常的 `handler`
  处理：以 `TypeError` 发出 `handler_error`，并应答异常 `0x04`。其中的寄存器值与单点访问器的
  返回值同样检查（见下文“无效的寄存器值”）。

**`handler` 是同步的。** 它的函数直接返回值；不支持返回 Promise。被调用时，数据必须实时可达。
推荐把数据保存在内存中（例如一个 `Buffer`）。位于别处的数据（例如 PLC）由调用者负责读入内存并保持
同步，例如由事件驱动；从慢速数据源读取不是 `Modbus_Server` 的使用场景。

**离散输入。** `get_discrete_input` 和 `get_discrete_inputs` 让 `handler` 把离散输入（FC 2）与
线圈（FC 1）分开；两者都是可选的。

- `handler` 有其中任意一个时，FC 2 使用它们：有 `get_discrete_inputs` 时每个请求调用一次，否则
  每个点调用一次 `get_discrete_input`。
- 两者都没有时，FC 2 按 FC 1 处理，经 `get_coils` / `get_coil` 读取，因此不区分两张表的
  `handler` 照常工作。
- FC 1 始终使用线圈的方法。

服务端把读到的值打包/序列化进响应。

**抛出异常的 `handler`。** 如果某个 `handler` 函数抛出异常，服务端以该错误发出 `handler_error`，并以
异常 `0x04`（服务器设备故障）应答该请求，而不是返回数据响应。与 `error` 不同，没有监听者时
`handler_error` 会被忽略，因此有缺陷的 `handler` 不会让服务端崩溃。

**无效的寄存器值。** 寄存器读访问器返回的不是 `0..65535` 的整数时（`undefined`、`null`、小数、
字符串、越界值），按抛出异常的 `handler` 处理：服务端以 `TypeError` 发出 `handler_error`，并应答
异常 `0x04`。服务端从不转换这个值。线圈读访问器返回真值或假值，任何值都有效。

**无效请求。** 在调用 `handler` 之前，服务端会校验请求数据和地址区间（见 `spec-protocol.zh-cn.md`
的“异常响应”）；无效请求以异常应答，且不调用 `handler`。

## 方法

- `start()`、`stop()` — 见“生命周期”。
- `is_valid_unit_id(unit_id)` — 服务端是否接受给定的单元 ID。

## 生命周期

`start()` 和 `stop()` 返回 Promise。`start` / `stop` 事件保留，触发方式不变；Promise 在事件之后
落定。

### `start() → Promise<void>`

开始监听（TCP 系列）或打开串口。首次串口 `start()` 会创建串口，此时才加载 `serialport-rs` 及其原生
绑定。

- 监听器开始监听或串口打开后兑现，晚于 `start` 事件。
- 在此之前的第一个错误会使其拒绝：地址已被占用（`EADDRINUSE`）、无法创建串口（例如原生绑定加载
  失败）或无法打开串口。此后服务端处于停止状态，之后的 `start()` 会重试。
- **由谁处理失败。** 调用者两种方式都没有处理的失败会让进程崩溃，这与没有监听者的 `error`
  一向的表现相同：
  - 有 `error` 监听者时，服务端先把 Promise 标记为已处理，再作为 `error` 发出该错误并拒绝。
    不 `await` 的调用者不会遇到 `unhandledRejection`，因此监听 `error` 的代码行为与以前相同。
  - 没有监听者时，不发出任何事件，Promise 直接拒绝。任何常规的拒绝处理方式都能捕获该错误：在
    `try` 中 `await`、`.then(on_ready, on_fail)`，或 `.then(on_ready).catch(on_fail)`。否则该拒绝
    未被处理，Node.js 终止进程。
- **重启。** 服务端已启动时，`start()` 先像 `stop()` 那样停止它（销毁所有存活的套接字，发出
  `stop`），再重新启动；Promise 在新的这次启动上落定。

### `stop() → Promise<void>`

停止服务端。TCP 系列：销毁所有存活的套接字并关闭监听器。串口：关闭端口。

- 监听器或串口完全关闭后兑现，晚于 `stop` 事件；服务端未启动时（从未启动、已经停止，或传输层已自行关闭）立即兑现。
- 从不拒绝：调用者没有什么可补救的，服务端无论如何都视为已停止。关闭时的错误在服务端有 `error`
  监听者时作为 `error` 发出，否则丢弃。

### 重叠的调用

`start()` 和 `stop()` 按调用顺序逐个执行：在另一个调用尚未落定时发起的调用，会等它落定后再执行。
如果最后一个待决的调用与新调用同类，新调用就并入它并返回同一个 Promise：启动过程中再次
`start()` 不会重启，停止过程中再次 `stop()` 也不会重复关闭。调用一旦发出其结果事件，即 `start` 或
`stop`，或使其失败的 `error`，就不再可并入。在该事件的监听函数中或在其之后发起的调用会重新执行：
`start` 之后的 `start()` 会重启，失败之后的 `start()` 会重试，而不是拿到同一个失败。

例如，连续调用 `start(); stop(); start();` 会依次打开、关闭、再打开；而 `start(); start();` 只打开
一次。

### 启动之后的错误

启动之后，传输错误照旧作为 `error` 发出；没有 `error` 监听者时由 `EventEmitter` 抛出。传输层自行
关闭时（例如拔掉串口适配器）发出 `stop`，服务端视为已停止。

## 事件

所有传输方式的事件名都相同；`socket_*` 事件只存在于 TCP 系列传输（TCP 和 RTU-over-TCP）。

| 事件                | 传输方式        | 参数     | 触发时机                                    |
| ------------------- | --------------- | -------- | ------------------------------------------- |
| `start`             | 全部            | —        | 监听器或串口已就绪。                        |
| `stop`              | 全部            | —        | 监听器或串口已关闭，无论是由 `stop()` 还是由传输层自身造成。 |
| `error`             | 全部            | `Error`  | 传输错误。`start()` 或 `stop()` 待决期间，仅在有监听者时发出（见“生命周期”）。 |
| `socket_connect`    | TCP 系列        | `socket` | 有客户端连接。                              |
| `socket_disconnect` | TCP 系列        | `socket` | 有客户端断开。                              |
| `socket_error`      | TCP 系列        | `Error`  | 单个连接的错误。                            |
| `send`              | 全部            | `Buffer` | 一帧已写出。                                |
| `receive`           | 全部            | `Buffer` | 收到一帧。                                  |
| `handler_error`     | 全部            | `Error`、请求 | 某个 `handler` 函数抛出了异常；该请求已以 `0x04` 应答。 |
