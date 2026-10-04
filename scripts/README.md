# 開発・検証ツールの配置

実装の責務に合わせて配置しています。実行はリポジトリルートから行います。依存情報の正本と編集例は [native 依存の更新手順](../docs/native-dependencies.md) を参照してください。

| 場所 | 役割 | 主な入口 |
| --- | --- | --- |
| `scripts/` | 共通のバージョン・リリース・ライセンス検証とファイル読み取り | `check-version.mjs`、`check-release.mjs`、`check-production-features.mjs`、`audit-js-licenses.mjs`、`release.mjs` |
| `native/build/` | libmpv ビルド、ORT 対応ソース収集、ソース archive の生成・検証 | `Dockerfile`、`native-ci-artifact.mjs`。ビルドは標準 `docker buildx build`。 |
| `native/windows/` | Windows DLL の準備・実ロード、installer の準備・監査・ライフサイクル確認 | `native-prepare.ps1`、`native-smoke.ps1`、`native-installer-audit.mjs`、`package-verify.ps1` |
| `e2e/support/` | 実 Tauri E2E、WebDriver、標準ユーザーでのプロセス管理、fixture、必須 Rust 統合テスト | `pnpm test:e2e`、`pnpm test:fixtures`、`pnpm test:rust:required`、`prepare-webdriver.ps1` |
| `e2e/browser/` | CI とローカルで共有するブラウザー・visual テスト環境 | `Dockerfile` |

回帰テストは対象の実装と同じディレクトリに置き、`pnpm test:scripts` が上記と `.devcontainer/` のテストをまとめて実行します。共通のテスト初期化は `scripts/test-setup.mjs`、ストリーミング SHA-256 と BOM 対応 JSON 読み込みは `scripts/file-content.mjs` です。

Windows の Runtime/driver 検出・署名確認・権限制御・DLL 読み込み・installer 動作確認は OS 固有の処理として維持します。installer の展開と監査は `native/windows/native-installer-audit.mjs audit INSTALLER` で実行し、E2E の親子プロセス起動は `e2e/support/run-native-e2e.mjs` が管理します。

libmpv と ORT の source archive は `native/build/native_source_archive.py` で生成します。各生成処理が入力を選択し、ファイル順序・所有者・時刻・権限を固定して `native-source-archive-check.py` で照合します。生成 recipe は Docker の入力と配布 source に含まれます。`native/reviews/` の既存パスとハッシュは採用時点の証跡で、過去のビルド内容を記録しています。

通常のアプリ変更では native 依存の Docker cache を再利用し、取得済み出力の整合性とアプリ・installer の動作を検証します。作業後の容量整理は標準 `cargo clean` や対象 container の `docker stop` / `docker rm` を使います。専用の整理スクリプトはありません。

実行手順は [開発コマンド](../README.md#development)、[E2E](../e2e/README.md)、[native build / package](../docs/native-runtime.md)、[source rebuild](../native/SOURCE-REBUILD.md) を参照してください。自動実行の入口は [CI](../.github/workflows/ci.yml)、[native build](../.github/workflows/native-build.yml)、[手動 native acceptance](../.github/workflows/native-acceptance.yml) です。

リリースは [main の保護ルールとタグ作成手順](../README.md#ci-and-releases) に従います。`main` への直接 push が可能で、PR は任意です（PR を使う場合は Squash merge を推奨）。PR の承認・レビュー会話の解決・更新前の CI 成功は必須ではありません。CI は push 後と PR で引き続き実行されます。線形履歴の必須化と force push・ブランチ削除の禁止は維持します。直接 push または PR のマージ後、そのコミットの `main` push CI 成功を確認してから所有者がバージョンタグを作成・push します。集約チェック `ci` は `validate`・native build・Linux・Windows・package がすべて成功した場合だけ通り、タグの CI 成功後に同じ実行の成果物を公開します。`main` の push や PR では公開しません。

公開処理でアップロードする asset は Windows installer（`.exe`）・`surtitle-source.zip`・`SHA256SUMS.txt` の 3 ファイルです。公開処理は同じ Actions 実行の `release-<commit SHA>` artifact にある内部 bundle 全体を検証した後、installer と source ZIP の 2 件だけを記載した公開用 `SHA256SUMS.txt` を生成してアップロードします。内部 bundle の全ファイル用チェックサム、manifest、依存関係・SBOM、installer audit/smoke の JSON 証跡はそのまま保持し、追加の診断情報は `package-evidence-<commit SHA>` artifact に残します。CI の検証項目は変わりません。Actions artifact の保存期間はリポジトリ設定に従います。

一時的な失敗は同じタグの workflow を再実行します。不完全な draft が残った場合は draft だけを手動削除し、タグを残して再実行します。タグの移動・削除は所有者にも許可されません。コード修正や誤ったタグの訂正には新しいバージョンとタグを使います。
