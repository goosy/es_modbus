---
id: yjaww5qx
opened: 2026-10-24T02:34:21.148Z
closed: 2026-10-24T04:12:05.578Z
title: vector 增加可选的成批读写方法
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [68a16aa] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title: 问题描述
proposal_title: 解决提案
decision_title: 裁定
---

## 问题描述

服务端对一个请求的每个点调用一次 vector，vector 不知道一次请求的边界，没法把一次请求作为一个整体处理。来源是 modbus_emulator：它把 layout-data 的数据块发布为从站，vector 背后的数据源每次读写都有副作用。

**写方向（FC 15 / FC 16）。** 一个请求写多个线圈 / 寄存器，`set_coil` / `set_register` 被逐个调用：

- 一致性：一个 `Real` 占两个寄存器，写完第一个寄存器时数据块已检测变化并通知订阅者，订阅者会看到写了一半的值。
- 开销：变化检测和 `write` 事件每个点一次。实测一次写 125 个寄存器，逐点约 13.5 µs，在一次范围写入中完成约 7.7 µs；`write` 事件 125 次对 1 次，监听器越重差距越大。

**读方向（FC 1 / 2 / 3 / 4）。** 每个点调用一次 `get_coil` / `get_holding_register` / `get_input_register`。

逐点读取不只是性能问题（一次 125 个寄存器的请求约 10 µs，远小于通信耗时），还造成诊断上的错误。实例：modbus_emulator 的 vector 背后是 layout-data 的 Ldata，每次读调用一次 `read_bytes`，每次都发出一次 `access`（报告被读的 tag 的诊断事件）。一次 FC3 读 4 个寄存器发出 4 次，跨两个寄存器的 Real 出现 2 次；一次 FC1 读 16 个线圈发出 16 次。vector 没法把一次请求作为一个整体处理，也就无法修正。

## 解决提案

vector 增加可选的成批方法：可选、按功能码选择、没有时回退到逐点调用。

| 方法 | 用于 | 参数 / 返回 |
| --- | --- | --- |
| `set_coils(addr, values, unit_id)` | FC 15 | 参数 `values`：布尔数组 |
| `set_holding_registers(addr, values, unit_id)` | FC 16 | 参数 `values`：0..65535 的整数数组 |
| `get_coils(addr, quantity, unit_id)` | FC 1；FC 2 在 vector 没有离散输入方法时也用它（见 issue#2kn5yrqz） | 返回长度为 `quantity` 的 `Array` 或类型化数组，元素按真值取位 |
| `get_holding_registers(addr, quantity, unit_id)` | FC 3 | 返回长度为 `quantity` 的 `Array` 或类型化数组，元素为 0..65535 的整数 |
| `get_input_registers(addr, quantity, unit_id)` | FC 4 | 同上 |

- 单点写方法 `set_register` 同时改名为 `set_holding_register`，与 `get_holding_register` 和成批的 `set_holding_registers` 对称。协议上只有保持寄存器可写（FC 6 / FC 16），旧名没有歧义，改名只为命名对称。这是破坏性变更，0.3.0 是事实上的首个正式版本，可以接受。
- 有对应的成批方法时，一次请求只调用一次；没有时逐点调用。各方法相互独立。按功能码选择，与数量无关，一个点也用成批方法。每次请求时判断，替换 `server.vector` 立即生效。FC 5 / FC 6 仍调用单点的 `set_coil` / `set_holding_register`。
- `values[i]` 对应地址 `addr + i`；每次调用传入新数组，vector 可以保留。
- 只对通过 `check_request` 的请求调用。抛出异常的处理与其他 vector 函数相同（`vector_error`，异常 0x04）。没有成批写方法时，逐点写入中途抛出即终止该请求，之前的点已写入。
- 成批读的返回值不是 `Array` 或类型化数组、长度不等于 `quantity`、或寄存器值不是 0..65535 的整数时，按 vector 错误处理：以 `TypeError` 发出 `vector_error`，答 0x04。
- 成批读返回 `Array` 或类型化数组（如 `Uint16Array`），与成批写的参数类型对称；vector 可以直接返回自身存储的视图（如 `subarray`）。寄存器返回大端 `Buffer`：不采纳，类型化数组已能直接返回存储，且元素即寄存器值，不必再按字节解码。
- 使用方 modbus_emulator 随后改用这些方法，在一次范围读写中完成一个请求，属于该仓库的工作。

成批写的意义：

- 一致性（主要理由）：一次请求的全部点一步写入，占多个寄存器的值（如 `Real`）不会以写了一半的状态暴露给订阅者。
- 每个请求只做一次的工作只做一次：定位数据、检测变化、通知订阅者（`write` 事件）从每个点一次变为每个请求一次。
- vector 可以把一次请求翻译为对数据源的一次范围写入，而不是 n 次。
- 开销：实测写 125 个寄存器约快 1.7 倍；监听器越重，收益越大。

成批读的意义：

- 读的副作用每个请求只产生一次（主要理由）：vector 背后的数据源每次读取都有副作用（如诊断事件、访问计数、按需刷新）时，一次请求只产生一次，而不是每个点一次。对 modbus_emulator 来说，一次读请求对每个块只发出一次 `access`，tag 集合不重复。
- vector 可以把一次请求翻译为对数据源的一次范围读取（如一次 `Ldata.read_bytes`），而不是 n 次。
- 与成批写对称，vector 的读写两个方向都能以请求为单位处理。
- 开销是次要收益：实测读 125 个寄存器逐点约 10 µs，一次范围读取约 0.2 µs。
- 一致性不是成批读的理由：vector 是同步的，逐点读取之间数据不会被其他代码修改，逐点读取得到的已经是一致的快照。

## 裁定

fixed。按提案实现：五个可选成批方法与 `set_register` 改名为 `set_holding_register`，契约写入 `spec-server`。成批读写让 vector 能以请求为单位处理，解决写一半可见与读副作用重复的问题，且对不提供成批方法的 vector 回退为逐点调用。modbus_emulator 改用这些方法属于该仓库的工作。
