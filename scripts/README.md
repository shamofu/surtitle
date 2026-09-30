# scripts の役割

依存情報の正本と編集例は [native 依存の更新手順](../docs/native-dependencies.md) を参照してください。

実行環境の準備・実アプリの検証・Windows 配布物の作成に使うスクリプトです。補助モジュールは表の入口から呼ばれます。

| 用途 | ファイル | 役割・呼出元 |
| --- | --- | --- |
| アプリ検証 | `run-required-rust-tests.mjs` | FFmpeg・libmpv・Silero を使う統合テストを明示的に実行し、対象なしの成功を防ぐ。`pnpm test:rust:required`、CI、手動 native acceptance。 |
| アプリ検証 | `run-native-e2e.mjs`、`native-e2e-worker.mjs`、`webdriver-process.mjs` | 実 Tauri アプリの操作・再起動を検証し、起動したプロセスを管理する。`pnpm test:e2e`、`wdio.conf.js`、production smoke。 |
| アプリ検証 | `native-smoke.ps1` | 実際の DLL をロードし、mpv・ORT の初期化を確認する。Windows CI、installer smoke、ローカル準備後。 |
| アプリ検証 | `generate-fixtures.mjs`、`generate-multitrack-fixture.mjs` | 再生・音声トラック選択・長時間メディア用の入力をローカル生成する。`pnpm test:fixtures`、native acceptance。 |
| アプリ検証 | `*.test.mjs`、`test-setup.mjs` | 上記と下記の保守対象スクリプトの回帰テスト・共通設定。`pnpm test` / `pnpm test:scripts`。 |
| 配布 | `check-version.mjs`、`check-release.mjs`、`check-production-features.mjs` | リリース番号の整合性、安定版タグの形式・番号・`main` 履歴への所属、開発専用機能の製品への混入を検出する。CI の `validate`、製品検証。 |
| 配布 | `audit-js-licenses.mjs`、`licenses.hbs` | 同梱 JavaScript / Rust 依存の notices とソース情報を用意する。CI、`package-verify.ps1`、cargo-about。 |
| 配布 | `native-ci-artifact.mjs` | native 出力のファイル集合・SHA を検証し、現在の checkout の manifest に適用する。native build の export 後、Windows CI の consume、最終 source ZIP 検証。 |
| 配布 | `native-audit.mjs` | 配布対象 DLL・notices・source 情報と PE 依存関係を確認する。`package-verify.ps1`。 |
| 配布 | `native-installer-prepare.py` | 標準 Tauri installer の同梱 source / notices を収集する。package CI。NSIS や plugin の独自ビルドは行わない。 |
| 配布 | `native-installer-audit.mjs`、`native-installer-audit.ps1` | 実際の installer を展開し、埋込み EXE・resources と同梱 source 情報を確認する。`package-verify.ps1`。 |
| 配布 | `package-verify.ps1`、`package-installer-smoke.ps1`、`package-production-smoke.mjs` | 製品 installer のインストール・上書き・起動・アンインストールと source ZIP を検証する。package CI。使い捨て Windows 環境で実行する。 |
| 配布 | `release.mjs`、`release-contract.mjs` | 検証済みの配布ファイル集合と既存タグの参照先を確認し、既存リリースを上書きせず公開する。package 検証と `vX.Y.Z` タグの CI。 |
| 依存更新 | `native-source-inputs.py`、`native_source_manifest.py`、`native-build.sh`、`native-build-evidence.py` | source catalog の URL / ファイル名 / submodule 記録を導出し、libmpv DLL と対応する source / inventory を生成する。`native/build/Dockerfile` の cache miss 時。 |
| 依存更新 | `native-ort-source-inputs.py`、`native-ort-compare.py`、`native-ort-generated.py`、`native-ort-package.py` | 採用した公式 ORT DLL に対応する source を取得・照合・梱包する。Docker の cache miss 時。 |
| 依存更新 | `native-source-archive-check.py` | 生成した native source tar の内容を、レビュー済み入力と照合する。上記の libmpv / ORT package 生成時。 |
| 依存更新 | `native-ort-evidence.py` | ORT を更新する際、公式 DLL / PDB の照合入力を採取する手動ツール。通常の CI では実行しない。 |
| ローカル開発 | `native-ci-build.sh` | Docker の native build と 6 ファイルの export を呼ぶローカル入口。依存が未変更なら完成済みステージを再利用する。 |
| ローカル開発 | `native-prepare.ps1` | manifest に従い DLL・notices、必要なら開発用モデルを配置する。Windows CI とローカル Tauri 開発。 |
| ローカル開発 | `prepare-webdriver.ps1` | 実 WebView2 に対応するテスト用 driver を用意する。Windows CI と E2E のローカル準備。 |
| ローカル開発 | `run-windows-standard-user.ps1`、`windows-standard-user.cs` | Windows のテストアプリ・fixture 作成を同じ標準ユーザー権限で起動する。E2E worker、CI の seed、installer smoke。 |

共通のファイル読み取りは `file-content.mjs` が担当します。ストリーミング SHA-256 と BOM 対応 JSON 読み込みを共有し、パス・リンク・ファイル集合の検証は各利用側で行います。

libmpv と ORT の source archive は `native_source_archive.py` で生成します。入力の選択とレビュー照合は各生成スクリプトが担当し、共通処理がファイル順序・所有者・時刻・権限を固定して、`native-source-archive-check.py` による内容照合まで実行します。生成に使うスクリプトは Docker の入力と配布 source の recipe に含めます。

通常のアプリ変更では native 依存の Docker cache を使い、取得済み出力の整合性とアプリ・installer の動作を検証します。

実行手順は [開発コマンド](../README.md#development)、[E2E](../e2e/README.md)、[native build / package](../docs/native-runtime.md)、[source rebuild](../native/SOURCE-REBUILD.md) を参照してください。自動実行の入口は [CI](../.github/workflows/ci.yml)、[native build](../.github/workflows/native-build.yml)、[手動 native acceptance](../.github/workflows/native-acceptance.yml) です。

リリースは [main の保護ルールとタグ作成手順](../README.md#ci-and-releases) に従います。作業ブランチから `main` への PR を Squash merge し、そのコミットの CI 成功後に所有者がバージョンタグを作成・push します。集約チェック `ci` は `validate`・native build・Linux・Windows・package がすべて成功した場合だけ通り、タグの CI 成功後に同じ実行の成果物を公開します。`main` の push や PR では公開しません。

一時的な失敗は同じタグの workflow を再実行します。不完全な draft が残った場合は draft だけを手動削除し、タグを残して再実行します。タグの移動・削除は所有者にも許可されません。コード修正や誤ったタグの訂正には新しいバージョンとタグを使います。
