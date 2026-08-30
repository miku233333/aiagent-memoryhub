# AI Agent MemoryHub

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | **日本語** | [English](README.en.md)

**AI Agent MemoryHub** は、ローカルファーストで監査可能な、AI クライアント間のメモリ同期プロジェクトです。Memory Hub を唯一の canonical な正本とし、承認済みの情報から対象ごとに生成したコンテキスト projection を Claude Code、Claude Web、その他のアダプターへ渡します。ベンダー内部のチャット履歴やネイティブメモリを、書き込み済みであるかのように扱うことはありません。

現在のバージョンは `0.1.0` です。公開リポジトリ：
[`miku233333/aiagent-memoryhub`](https://github.com/miku233333/aiagent-memoryhub)。

## デスクトップアプリ

このプロジェクトには、Electron 40 をベースとしたクロスプラットフォームのデスクトップアプリが含まれています。アプリの起動時に内蔵のローカル Hub が自動的に立ち上がり、既存の React/Vite コンソールを使用します。canonical SQLite データはユーザーのアプリデータディレクトリに保存されるため、Python バックエンドと Web 開発サーバーを別々に起動する必要はありません。

デスクトップアプリは初回起動時に、同じユーザーデータディレクトリへ権限を制限したローカル Hub 認証情報を生成します。Electron がこの認証情報を付加するのは、正確に `127.0.0.1:8787` 宛てのリクエストだけです。アダプターはこの非公開ファイルから認証情報を読み取れるため、token をプロジェクト設定や画面へコピーする必要はありません。

```sh
./script/package_desktop.sh mac
```

macOS ビルドでは DMG/ZIP を生成します。Windows ビルドでは
`./script/package_desktop.sh win` を使用して NSIS インストーラーを生成します。アプリは
`electron-updater` を通じて、固定された GitHub リポジトリの最新 Release を確認します。より新しいバージョンが見つかった場合は、最初にユーザーへ通知し、確認なしにダウンロードやインストールを行うことはありません。

アーキテクチャ全体、署名状況、リリース時のチェックについては、[デスクトップアプリの説明](docs/desktop-app.md)を参照してください。

## 現在実行できるエンドツーエンドの縦断フロー

```mermaid
flowchart LR
    A["クライアント Hook / MCP"] --> B["メモリ提案"]
    B --> C["ユーザー承認"]
    C --> D["SQLite canonical memory"]
    D --> E["Scope + secret チェック"]
    E --> F["対象別 projection"]
    F --> G["クライアントコンテキスト"]
    G -. "受領通知または digest の readback" .-> H["監査ステータス"]
```

- FastAPI + SQLite Memory Hub：提案、承認、検索、コンテキストパック、忘却 tombstone、冪等 checkpoint。
- React コンソール：概要、メモリ、コンテキスト、コネクター、環境診断、Claude アカウント安全性、監査、projection 設定。
- Claude Code：4 つの lifecycle Hooks、増分 JSONL cursor、コンテキスト注入、提案/checkpoint。
- Claude Web：実行可能な Streamable HTTP REST→MCP bridge。実際のリモート接続には、引き続き HTTPS/OAuth ゲートウェイが必要です。
- Codex：依存関係のない REST CLI + Hook runtime。Qoder と Grok Build も、この安全な runtime を再利用します。
- ChatGPT Web：独立したリモート MCP アプリテンプレート。Codex とは別に表示され、プランおよびワークスペースのポリシーによる制限を受けます。ChatGPT のネイティブメモリへ書き込んだと主張することはできません。
- OpenClaw と Hermes：host-independent な契約テスト済みのプラグイン/provider スケルトン。実際のホストでの読み込みは未検証です。
- Gemini Spark と Grok Web：リモート MCP テンプレートのみ。現在、Hub の `/mcp` は明示的に 501 を返すため、接続済みであるとは主張できません。
- 国際化表現のリライト：Claude/Claude Code 向けの送信 projection のみを生成します。デフォルトでは無効で、canonical を書き換えることはありません。
- Env Doctor：読み取り専用チェック + dry-run のセットアップ計画。明示的に `--apply` を指定した場合に限り、ローカルの Claude Code 設定へ書き込みます。

その他のクライアントの機能と現在の実装レベルについては、[プラットフォーム機能マトリクス](docs/platform-capabilities.md)を参照してください。

## ローカルでの起動

Python 3.12+、[`uv`](https://docs.astral.sh/uv/)、Node.js 20+ が必要です。

デスクトップ版だけを使用する場合は、`./script/build_and_run.sh` を実行するだけです。バックエンドとフロントエンドを個別にデバッグする場合は、まず今回の開発セッション用に一時的なローカル token を生成します。この token は、2 つのターミナルの環境変数内にだけ保持されます。

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

出力を `<local-token>` とします。1 つ目のターミナル：

```sh
cd backend
uv sync --extra dev
MEMORY_HUB_TOKEN='<local-token>' uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

2 つ目のターミナル：

```sh
cd web
corepack pnpm install --frozen-lockfile
MEMORY_HUB_TOKEN='<local-token>' corepack pnpm dev
```

`http://127.0.0.1:4173` を開きます。Vite は `/health` と `/v1` を、デフォルトの Hub アドレス `http://127.0.0.1:8787` へプロキシします。バックエンドを利用できない場合、コンソールには「デモデータ」と明示的に表示されます。

## 環境診断と安全なセットアップ

```sh
cd tools/env-doctor

# 読み取り専用チェック
python3 -m env_doctor check --project-root ../.. --json

# 明示的なネットワークアクセス：Claude の公式ドメイン 2 件だけを対象に DNS/TLS を確認し、公開 IP や位置情報は照会しません
python3 -m env_doctor check --project-root ../.. --probe-network --json

# 変更計画のみを生成
python3 -m env_doctor setup --project-root ../.. --user-id local-user

# レビュー後にのみ適用。書き込み前にバックアップします
python3 -m env_doctor setup --project-root ../.. --user-id local-user --apply
```

動作全体と復旧の境界については、[Env Doctor README](tools/env-doctor/README.md)を参照してください。

## Claude との連携

- [Claude Code adapter](adapters/claude-code/README.md)：プラグイン Hook をコピー/登録し、固定されたローカルの user/project scope を設定します。
- [Claude Web MCP bridge](adapters/claude-web/README.md)：ローカルで検証可能な MCP ツール。実際の Claude Custom Connector へ接続する前に、公開 HTTPS、認証、デプロイレベルのアクセス制御を追加する必要があります。

「Hook 成功」は、コンテキストが注入されたことだけを示します。「HTTP 2xx」は、アダプターが受信したことだけを示します。対象側から同じ nonce、scope、digest を readback できた場合に限り、画面には「同期済み」と表示できます。

## 検証

```sh
(cd backend && uv run --no-editable pytest -q && uv run --no-editable ruff check . && uv run --no-editable ruff format --check . && uv build)
(cd web && corepack pnpm test && corepack pnpm build)
(cd adapters/claude-code && npm test && npm run check)
(cd adapters/claude-web && npm test && npm run check)
(cd adapters/codex && npm test)
(cd adapters/openclaw && npm test)
(cd adapters/hermes && python3 -m unittest discover -s tests -v)
(cd tools/env-doctor && python3 -m unittest discover -s tests -v)
```

これはローカルの単一ユーザー向け PoC であり、マルチテナントの ID システム、マネージドデータベース、内蔵のリモート OAuth ゲートウェイは含まれていません。また、実際の Claude/ChatGPT アカウントを使用した最終的な UI 検証も完了していません。デスクトップパッケージは端末固有の bearer を生成し、loopback-only を維持します。個別に開発環境を起動する場合も、`/v1` に同じ bearer を設定する必要があります。リモートへデプロイする場合は、認証、TLS、テナント境界、DLP、レート制限、取り消し可能な配信受領通知を別途用意する必要があります。
