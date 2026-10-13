# MosDNS v2 上游重建

## 基线和范围

- 基于 sbwml/v5 `bd40245303cd0ba56804d49eed5dbc4be2a082ca`，不是旧 fork 的补丁叠加。
- 兼容旧 v2 UCI 字段、规则文件和自定义 YAML；保留上游日志、统计、可选预取、geo2txt 和核心补丁。
- 对接目标：coolsnowwolf/lede `dcafc376a688efb0887b661b3a98a4c41a725984`，LuCI openwrt-25.12 `cae27bd8ad448b7d6216c581cd2852ffa971b1c5`。
- 这是经宿主机功能回归验证的开发分支。尚未完成 OpenWrt SDK 打包和真实路由器验收；宿主机原生 libuci 解析及迁移也有独立测试。

## 架构

- `v2-config.uc`：无副作用的配置编译器。
- `v2-migrate.uc` / `v2.uc`：幂等迁移、备份、原子 UCI 文件替换、文件清单及可读性检查。
- `mosdns.uc`：受检更新、独立规则恢复、geo 数据导出；维护操作通过 init reload 生效。
- `redirect.uc`：仅修改首个 dnsmasq 实例，保存完整 server 列表和选项缺省状态，不修改其他实例，不执行锁文件中的 shell。
- init：生成候选配置、geo 私有副本，验证后停止旧 PID；确认退出后删除 dump，发布配置/geo，启动并检查健康，失败尝试恢复最后一次可用生成配置和 geo。
- LuCI：标准 form/view/Save & Apply，稳定命名 DNS 组 ID，排序规则及独立排序 IP 映射；显示服务和最后 apply 状态。

## DNS 语义

1. 可选统计包装器。
2. 缓存优先。缓存保存完整规则及映射后的最终答案，因此命中直接返回，不再次映射。
3. 按 UCI 顺序执行启用规则；命中并取得答案即结束路由阶段。
4. 无答案时使用唯一默认 DNS 组和 fallback IP 策略。
5. 独立响应 IP 映射按顺序执行。先判断当前响应是否匹配，再改写；停止模式使用有外层 continuation 的 `jump`，命中后确实退出后续映射。继续模式允许链式映射。
6. redirect 规则保留后续 DNS 查询 continuation，生成实际 CNAME/目标查询。

DNS 组显示名可改，规则引用的 UCI section ID 不变。匿名旧组迁移为同 ID 的命名 section。

## 有意保持保守的行为

- 旧 v2 没有效果的全局 minimum/maximum TTL、ECS、type65、dns_leak 保留原值，只读展示并明确无效，不因重建突然启用。每条规则 TTL 和 IP 策略正常工作。
- 预取和统计保留已有显式配置；旧 v2 缺失这些字段时不自动开启。
- 自定义 YAML 不改写、不清理引用文件。编辑通过有备份的原子写入；Save 本身不重启。自定义 YAML 没有通用离线校验器；核心在全部插件初始化完成后发布本进程 PID 就绪标记，init 验证该标记，即使自定义配置没有 API 也不会靠固定等待冒充就绪。该检查不保证 YAML 中自定义 DNS 逻辑符合用户意图。实际运行使用只读语义快照，启动失败时尝试恢复最后可用快照而不改写用户 YAML。新包模板 API 绑定 loopback，已有用户 YAML 不重写。
- 保留统计显示；移除原上游对固定黑/白名单文件的直接编辑快捷键，改为链接到有序规则页面，避免绕过 v2 规则选择与原子保存。
- HTTPS 广告源必须有安全、明确的文件名。拒绝不同 URL 复用相同文件名，避免覆盖。首次启用可在 apply 前仅准备缺失列表；完整更新保留旧自定义文件并检查每步错误。
- 删除不安全的一键下载安装流程。`install.sh` 仅给出官方 SDK 构建指引并失败退出，不下载或执行未校验包。

## 缓存和更新

- Save & Apply、规则恢复、geo/adlist 更新和手动清缓存使用完整 reload 生命周期。
- 生成模式配置或引用规则内容指纹变化时，普通 restart 也清 dump；指纹不变可保留缓存。自定义 YAML 每次启动保守地使所有 cache 插件失效，避免漏检外部引用文件及非默认 dump 路径。核心读取每个插件自身配置的路径；强制失效时拒绝符号链接/目录/设备等不安全最终路径；清理失败阻止插件启动，不重新加载旧 dump，不报告完全清理成功。dump 写入使用同目录临时文件和原子替换。运行中的热重载若持久化删除失败会清内存并写错误日志，不伪称磁盘已清除。
- `/ready` 只在全部插件初始化完成且未关闭时返回明确的 `ready`，init 同时校验状态和正文，拒绝旧核心的通用 200 页面。
- 旧进程必须完全退出，才删除磁盘缓存，避免退出回写复活旧 dump。
- 核心热重载使用 generation 屏障：成功加载新规则时清内存和 dump；旧前台查询、lazy 更新、prefetch 结果不能重新写入。无效规则保留旧 matcher 和缓存。
- 已经进行中的查询可完成旧答案，不强制取消；不会污染新一代缓存。
- geo 导出到私有候选目录，失败验证不会改写旧实例正在监视的文件。完整 adlist 更新采用逐文件原子发布；部分更新失败会报错并尝试 reload，不宣称整个批次已成功。

## 迁移、备份及恢复

- 首次迁移备份 `/etc/config/mosdns.pre-v2`，不重复覆盖备份。
- 丢失/不可读的旧文件不会阻止整个页面显示。编辑器说明错误并保留原引用；用户可禁用、删除规则或输入新内容显式替换。
- 不删除原规则文件，旧 UCI 文件/引用可由备份恢复。规则编辑生成不可变新文件；RPC 成功后才更新 UCI 指针，失败不会指向缺失文件。旧文件保留供恢复，未实现自动垃圾回收。
- 默认规则恢复备份原配置；保留所有规则文件，另建出厂为空的 DDNS 文件并指向它，避免误保留旧内容或破坏其他引用；失败回滚配置并重载。
- 自动恢复生成运行配置不等于回滚已被 LuCI 提交的 UCI。界面显示失败，用户需要修正配置并再次应用。
- **旧版 `redirect.lock` 特例：**旧版曾删除 dnsmasq server 列表且未备份，因此无法可靠推导原值。若仅发现此旧锁而没有新 JSON 备份，验证会阻止迁移激活，不把“已劫持配置”冒充原始备份。请先人工恢复 dnsmasq DNS 设置、保留并移走旧锁，再应用。原配置和锁保持不动。
- 普通 stop 恢复 dnsmasq 转发；新启动在健康检查通过后重新设置。

## 可运行测试

宿主机需要 Python 3、Node、ucode（fs 模块）；真实 DNS 测试需要编译了仓库全部补丁的 MosDNS。原生 UCI/ubus 不可用时使用明确标注的 fixture，不声称路由器运行通过。

```sh
export UCODE_BIN=/path/to/ucode
export UCODE="$UCODE_BIN"
export MOSDNS_BIN=/path/to/patched/mosdns
export GO=/path/to/go
export MOSDNS_UPSTREAM=/path/to/clean-v5.3.4-core-checkout
export UCI_MODULE_DIR=/path/to/ucode-modules
export REQUIRE_NATIVE_UCI=1
# 如用隔离动态库，可设置 LD_LIBRARY_PATH；Go 离线测试要求依赖已缓存。
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_ui.js
node tests/test_rpc.mjs
sh -n luci-app-mosdns/root/etc/init.d/mosdns
sh -n install.sh
git diff --check
```

覆盖：历史 v2/upstream 配置、幂等迁移、UTF-8/引号序列化、5 种 IP 策略、有序规则、默认组、停止/继续映射及缓存命中一致性、真实 loopback UDP redirect/hosts/TTL/拒绝、热编辑缓存更新与坏文件恢复、Go race、原子文件失败注入、dnsmasq 精确恢复、init 停止/作废顺序和回滚、LuCI 控件和 RPC 约定。

## 路由器验收清单

1. SDK 依赖/包构建及安装升级保留文件；不要直接覆盖在用机器而没有备份。
2. 两种真实配置分别迁移；重复开机/升级后引用和排序不变。
3. Save、Save & Apply、取消、重复提交、页面前进/后退、窄屏布局与实际主题。
4. procd 启停超时、重载错误、API/DNS 端口占用、dnsmasq 多实例和手动 stop。
5. geo/adlist 下载失败、路由器掉电/存储空间不足、缓存 dump 持久化和自定义 YAML。

## 提交身份

本开发分支的本地提交使用助手作者 `dot <dot@localhost>`，不是用户 Git 身份；不修改全局 Git 配置。远端发布取决于外部授权与连接结果，本文档不表示已推送。
