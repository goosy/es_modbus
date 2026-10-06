# es-modbus — 规格说明

> 本文是 [spec.md](spec.md) 的中文译本。

规格文档体系的入口。本文定义该库**提供什么**以及**为什么**；实现机制、实现现状和待办事项见
[design.zh-cn.md](./design.zh-cn.md)。

子文档：

- [spec-protocol.zh-cn.md](./spec-protocol.zh-cn.md) — Modbus 帧格式、区间表示法、功能码、CRC。
- [spec-client.zh-cn.md](./spec-client.zh-cn.md) — `Modbus_Client` 的 API、选项、事件、行为约定。
- [spec-server.zh-cn.md](./spec-server.zh-cn.md) — `Modbus_Server` 的 API、`vector` 处理接口、事件。
- [spec-test.zh-cn.md](./spec-test.zh-cn.md) — 自动化测试套件：覆盖范围、命令、串口测试环境、
  已知缺陷的标记约定。
- [design.zh-cn.md](./design.zh-cn.md) — 如何构建：内部机制、实现现状、已知缺陷与待办事项。

## 目标

为 Node.js 提供一个小巧、依赖很少的 Modbus 实现，在同一个包里同时提供 Modbus 通信的两端：

- `Modbus_Client` — 主站/客户端，发出读写请求，并以 Promise 返回结果。
- `Modbus_Server` — 从站/服务端，接收请求，并通过用户提供的数据访问回调（即 `vector`）作答。

客户端读写的是*区间*（range）：一个起始地址加一个长度。区间可以用 Modicon 表示法以 `string` 给出
（5 位或 6 位，例如 `"40001,73"`、`"400001,73"`），也可以是结构化的 PDU 区间（功能码、PDU 地址和
长度，全部为 `number`）。由类型决定，二者绝不混用。服务端只使用 PDU 地址。

## 范围

### 范围之内

- 传输方式：Modbus **TCP**、串口上的 Modbus **RTU**，以及 **RTU-over-TCP**
  （在 TCP 套接字上使用 RTU 帧格式）。
- 功能码 `1, 2, 3, 4, 5, 6, 15, 16`（读/写线圈与寄存器，单个与多个）。
- Modbus 异常响应（功能码 + `0x80`，外加一个异常码字节）。
- 多单元服务端：单个服务端实例可承载多个单元 ID（unit ID），并按单元 ID 路由。
- 客户端的事务跟踪、单请求超时、发送节流，以及 TCP 和 RTU-over-TCP 的自动重连。
- 两个类都提供事件发射器，用于线路跟踪（`send` / `receive`）和生命周期通知。
- 覆盖编解码、服务端和客户端的自动化测试套件（见 `spec-test.zh-cn.md`）。

### 范围之外

- 上述列表以外的功能码（诊断 `0x08`、文件记录访问、FIFO、封装传输等）。解析器会拒绝它们。
- ASCII 传输。
- 服务端上的任何持久化数据模型 — 存储完全由调用者的 `vector` 负责。
- TypeScript 类型（代码用 JSDoc typedef 描述数据形状）。

## 工具与依赖

- **运行时：** 使用 ES 模块的 Node.js（`"type": "module"`）。运行时只使用 Node 内置模块
  （`node:net`、`node:events`），串口/RTU 路径另外使用 `serialport`。
  发布的包**没有任何运行时依赖**：用户只需安装 `es-modbus`。`serialport`（其中的
  `@serialport/stream` 和 `@serialport/bindings-cpp` 两部分）被打包进 `dist/modbus.js`，
  `@serialport/bindings-cpp` 的原生预编译文件随包放在 `prebuilds/` 中（基于 N-API，每个平台一份文件
  即可用于所有 Node.js 版本）。打包产物只在首次使用串口时才加载 `serialport`，绝不在导入时加载：
  加载它会加载原生绑定，而在没有预编译文件的平台上（或禁止原生模块的进程中），TCP 也必须可用。
  被打包的包的许可证随包放在 `THIRD_PARTY_LICENSES` 中。
- **Node.js 版本：** `>=20.11`（`engines`），因为用到了 `import.meta.dirname`。
- **包管理器：** pnpm（必须使用 — 见 `AGENTS.md`）。
- **打包器：** Rolldown，由 `build.js` 通过其 API 调用（内置 Node 模块解析与 CommonJS 互操作，
  无需插件）。
- **测试：** Node.js 内置测试运行器（`node:test`）。`serialport`、`@serialport/stream` 和
  `@serialport/bindings-cpp` 列在 `devDependencies` 中：构建时打包它们，串口测试用 `serialport`
  作为原始对端串口。
- **代码检查：** ESLint 加 `@stylistic/eslint-plugin`（`eslint.config.js`），均在 `devDependencies`
  中锁定精确版本。ESLint 推荐规则负责发现代码问题；`@stylistic` 只统一空白（Tab 缩进、空格、引号、
  分号），不重新折行，因此手工排版的表格保持原样。不使用会重排代码的格式化工具（Prettier、Biome）。

## 构建与目录布局

| 路径                  | 作用                                                             |
| --------------------- | --------------------------------------------------------------- |
| `src/index.js`        | 公共接口：`export { Modbus_Client, Modbus_Server }`。            |
| `src/ModbusClient.js` | 客户端类。                                                       |
| `src/ModbusServer.js` | 服务端类。                                                       |
| `src/util.js`         | 纯协议编解码（帧解析、CRC、区间解析）。无 I/O。                  |
| `src/serial.js`       | 串口选项校验，以及串口创建（首次使用时才加载 `serialport`）。    |
| `build.js`            | 构建：将 `src/index.js` 打包为 `dist/modbus.js`，复制 `prebuilds/`，生成 `THIRD_PARTY_LICENSES`。 |
| `eslint.config.js`    | ESLint 与 `@stylistic` 配置。                                    |
| `dist/modbus.js`      | 构建产物（单个 ES 模块），也是包 `exports` 的入口。              |
| `prebuilds/`          | 构建产物：`@serialport/bindings-cpp` 的原生预编译文件，打包产物在 `dist/../prebuilds` 处查找它们。 |
| `THIRD_PARTY_LICENSES` | 构建产物：被打包的包的许可证文本。                              |
| `test/*.test.js`      | 自动化测试（见 `spec-test.zh-cn.md`）。                          |
| `test/helpers.js`     | 共享的测试夹具。                                                 |

构建产物已被 git 忽略，由 `pnpm build` / `prepare` 生成，并通过 `package.json` 的 `files` 发布。

命令：

- `pnpm install`
- `pnpm build` — 运行 `build.js`；在导入 `../dist/modbus.js` 的任何操作之前运行。
- `pnpm test` — 先构建，再运行自动化测试套件（`node --test`）。
- `pnpm test:coverage` — 运行测试套件并输出 `src/` 的覆盖率报告。
- `pnpm lint` — 运行 ESLint（`eslint .`）；`pnpm lint --fix` 应用可自动修复的规则。它与 `pnpm test`
  相互独立。

## 约定

- 源码仅使用 ESM；标识符使用 `snake_case`，外部接口另有规定的除外（见 `AGENTS.md`）。
- 解析时会校验所支持的功能码和 PDU 长度；格式错误的帧会被丢弃，而不是抛出异常。
- 区间在公共 API 中有两种形式，按 JavaScript 类型区分，定义见 `spec-protocol.zh-cn.md`：
  `string` 是 Modicon 表示法（5 位或 6 位），数组或对象是结构化的 PDU 区间。

## 待决问题

spec 尚未做出的决定。先在 spec 中定下来，再去实现。

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
