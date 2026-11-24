# dsh-work-migrator

把一个 DSH 开发工作——**代码、数据和对话记录**——导出成一个 `.dsht` 包，
在另一台电脑上导入，并按你选择的分组归档。导入后对话可以继续使用。

## 为什么需要它

DSH 里一个工作分散在工作目录和 `%USERPROFILE%\.dsh\sessions` 两处。
搬动或改名工作目录后，对话里记录的路径就会失效。本插件在搬家的同时改写这些引用。

## 导出

侧边栏底部「⇅ 迁移」→ **导出**：

1. 勾选要导出的工作。
2. 填写保存路径（如 `D:\Harness Record\导出.dsht`）。
3. 点「开始导出」。

产物是 zip 格式的 `.dsht` 文件，内含代码、数据和会话日志。
凭据（`.credentials.yaml`、token、secret、`id_rsa`、`.env`）一律不打包；
`node_modules`、`.venv`、`__pycache__` 默认跳过。导出不修改任何数据，DSH 开着也能用。

## 导入

「⇅ 迁移」→ **导入**，填写包路径，点「读取」，再逐个指定归属：
保持原分组、归到现有分组、新建分组（文件夹自动创建）或跳过。

确认后，一个脱离 DSH 生命周期的后台进程会备份会话、投影缓存和 `workspace.json`，
复制代码，改写对话的 `header.cwd`，移动会话目录，更新工作区登记并重启 DSH。
任一环节失败都会整体回滚，并在 `storages\work-migrator\` 留下日志。

## 限制

- **导入必须重启 DSH 才能生效**——运行中的 DSH 在内存里持有会话状态。
  插件会让你关闭 DSH，然后在之后完成导入并自动重新打开。
- 包路径需要手动输入完整路径：DSH 有目录选择器，但没有文件选择器。
- 导入过程中不要手动修改工作目录或会话文件。
- 单个包超过 4 GB 不支持。
- 在 Windows 上开发和测试，其他平台未验证。

## 安装

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-work-migrator
```

安装后重启 DSH。

## 卸载

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-work-migrator
```

## 许可证

MIT
