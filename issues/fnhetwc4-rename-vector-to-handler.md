---
id: fnhetwc4
opened: 2026-10-24T06:26:15.703Z
closed: 2026-10-24T06:26:35.586Z
title: 服务端的 vector 改名为 handler
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [36ac96a] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title: 问题描述
proposal_title: 解决提案
decision_title: 裁定
---

## 问题描述

`Modbus_Server` 的第一个参数叫 `vector`，这个名字沿用自 `modbus-serial` 的
`ServerTCP(vector, options)`。那里的 `vector` 是一组回调（`getCoil`、`getHoldingRegister` 等），
意思接近"中断向量表"：功能码映射到处理函数。

这个名字在本库中不合适：

- 在 JS 语境里，"vector" 首先让人想到数组或数学向量。成批读又可以返回 typed array，
  "`vector` 返回数组"这种说法更容易让人混淆。
- 它实际扮演的角色是服务端背后的数据模型或处理器，名字没有说出这一点。
- 不认识 `modbus-serial` 的用户看不出它的含义，只能去查文档。

本库是独立的 Modbus 库，不需要沿用 `modbus-serial` 的命名。

## 解决提案

`vector` 改名为 `handler`：名称短，含义一看就懂，`handler_error` 也比 `vector_error` 自然。
相关名称一并改名：

- 构造参数 `vector` 改为 `handler`，`ModbusVector` 类型改为 `Modbus_Handler`，
  `Vector_Error` 改为 `Handler_Error`，`call_vector()` 改为 `call_handler()`。
  构造参数是位置参数，这些改名不影响调用方。
- 实例属性 `vector` 改为 `handler`，事件 `vector_error` 改为 `handler_error`。这对调用方是破坏性的，
  但 0.3.0 是事实上的首个正式版本，本来就处在破坏性变更的阶段，而且这个属性和事件目前还没有人使用。
  CHANGELOG 中注明。

## 裁定

fixed。按提案改名：`vector` 改为 `handler`，`vector_error` 事件改为 `handler_error`，相关的类型、
错误类和方法一并改名。本库是独立的 Modbus 库，应当使用一目了然的名称；破坏性的部分发生在首个正式版本之前，
且尚无人使用。
