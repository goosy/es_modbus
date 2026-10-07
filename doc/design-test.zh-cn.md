# 设计：测试套件

> 本文是 [design-test.md](design-test.md) 的中文译本。

本库**如何**测试：什么在哪里测、套件如何运行，以及所需的环境。这是从 [design.zh-cn.md](./design.zh-cn.md)
拆出的一个主题。

## 原则

- 通过公共 API 进行的测试（单个类对接伪对端、两个类端到端互测、构建产物）检查 `spec-*` 系列规定的
  行为，而不是以当前代码为准。`src/util.js` 中各函数的测试检查 `design.zh-cn.md` 描述的机制。
- 由 `src/util.js` 中纯函数实现的规则，在那里逐条测试。类的测试只检查类确实应用了它：通过类测一两个
  用例，不再把整张表重测一遍。
- 代码尚未满足规格之处，测试仍然陈述规格要求的行为，并标记为 `{ todo }`，这样套件能显示缺少什么，
  而不会失败；修复后移除该标记。
- 不需要额外的测试依赖：套件使用 Node.js 内置的运行器（`node:test`、`node:assert/strict`）。
- 除构建产物测试外，测试直接从 `src/` 导入，因此源码测试无需构建。

## 分层

`test/util.test.js` 覆盖 `src/util.js`；`test/client.test.js` 和 `test/server.test.js` 分别单独
覆盖一个类；`test/tcp.test.js`、`test/serial.test.js` 和 `test/serial-bridge.test.js` 分别通过回环
TCP、一对串口和模拟串行线路对两个类做端到端测试；`test/bundle.test.js` 覆盖构建产物 `dist/modbus.js`
及 `prebuilds/`。夹具位于 `test/helpers.js` 和 `test/serial-bridge.js`。

## 命令

| 命令                 | 作用                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `pnpm test`          | 先运行 `pnpm build`，再用 `node --test` 运行所有 `test/**/*.test.js`。 |
| `pnpm test:coverage` | 同上，并输出仅限 `src/**` 的内置覆盖率报告。                          |

也可以直接运行 `node --test`；此时若 `dist/modbus.js` 不存在，或比 `src/` 中任一文件旧，构建产物测试
会被跳过。

## 伪对端与隔离

- 服务端在 `127.0.0.1` 上以端口 `0` 监听，因此每个测试都会得到一个空闲的临时端口，各测试文件可以
  并行运行。
- 客户端测试使用一个原始的 `node:net` 服务端充当伪从站，从而可以检查线路上的确切字节，并构造格式
  错误或乱序的应答。
- 服务端测试在不需要网络时通过伪套接字或伪串口把帧送入 `on_data`；在真实传输有意义时使用原始的
  `node:net` 套接字。
- 串口生命周期测试把 `src/serial.js` 的串口工厂替换为创建伪串口的工厂（`set_serial_port_factory`，
  不属于公共 API），因此不需要串口硬件，也不需要原生绑定。

## 串口测试

- 串口测试需要一对像零调制解调器线缆那样相连的串口，例如 com0com 端口对。服务端一侧打开第一个
  端口，对端（原始 `SerialPort` 或 `Modbus_Client`）打开第二个。
- 端口对通过环境变量 `MODBUS_SERIAL_PORTS="<服务端>,<对端>"` 设置；默认为 `COM11,COM12`。
  `MODBUS_SERIAL_PORTS=none` 跳过串口测试。
- 串口测试运行前会做一次预检：打开两个端口。任一端口无法打开，串口测试组即被跳过并注明原因，
  套件其余部分照常运行。

### 串口测试环境

串口测试组在 Windows 11 上通过一对 com0com 3.0.0.0 端口（默认参数）运行。

在 Windows 上，Node.js v26.4.0 及以后的版本中串口测试失败。自 v26.4.0 起，原生模块在异步工作中调用
JavaScript 之后，Node.js 不再代为执行 microtask 队列和 `process.nextTick` 处理函数，模块须自行用
`CallbackScope` 或 `MakeCallback` 完成（[nodejs/node#66158](https://github.com/nodejs/node/issues/66158)，
以“不予修复”关闭；[nodejs/node-addon-api#1756](https://github.com/nodejs/node-addon-api/issues/1756)）。
`@serialport/bindings-cpp` 13 在 Windows 上用普通调用完成读写，于是交付结果的 Promise 要等下一个宏任务
（例如定时器、关闭端口或再一次写入）执行时才会兑现
（[serialport/node-serialport#3148](https://github.com/serialport/node-serialport/issues/3148)）。
原因不在串口驱动：用原生 Win32 调用，同一对 com0com 端口上挂起的读操作在数据到达时会立即完成。
