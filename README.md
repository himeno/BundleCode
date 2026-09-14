# BundleCode

複数のワークスペースを **1 つのウィンドウに束ねて、左端のストリップで行き来する**コードエディタ。
[Code - OSS](https://github.com/microsoft/vscode)（VS Code のオープンソース版）のフォークです。

切り替えはビューの付け替えなので再読み込みが起きず、ターミナルも編集中のバッファも拡張機能の
状態もそのまま残ります。各ワークスペースは独立した workbench として動き、専用の拡張ホストを
持ちます。

> **非公式のフォークです。** Microsoft および VS Code チームとは関係がありません。
> 詳しくは[免責事項](#免責事項)を参照してください。

## 背景

VS Code は「1 ウィンドウ = 1 ワークスペース」が前提で、関わるプロジェクトの数だけウィンドウが
増えます。同時に 10 を超えると、⌘Tab で目当てのウィンドウを探すことが仕事の一部になり、
どれで何をしていたかも追えなくなります。かといってウィンドウを閉じれば、そこで走らせていた
ターミナルも開いていたファイルも失われます。

欲しかったのは、ターミナル多重化ソフトのサイドバーのように **プロジェクトの一覧が常にそこにあり、
押せば即座にその状態へ戻れる**エディタでした。

VS Code の前提そのものは作り替えていません。各ワークスペースは従来どおり完全な workbench で、
Electron の `WebContentsView` として 1 枚のネイティブウィンドウに並べ、見えるものを付け替えて
いるだけです。だから拡張機能の互換性は素の Code - OSS と同じで、上流への変更も小さく保てます。

## 何ができるか

- **プロジェクトの一覧**が左端に常駐し、クリックで切り替え。閉じたプロジェクトも一覧に残り、
  クリックで開き直せる
- **グループ**で一覧を整理し、**ドラッグ**で並べ替え。並びと名前は再起動をまたいで残る
- **最近使った順**への並べ替えをボタンで切り替え
- **絞り込み**（`⌘⌃F`）。名前とパスの両方に当たる
- **SSH 先のワークスペース**も同じ一覧に並ぶ。`~/.ssh/config` のホストから開ける
- 隠れているプロジェクトのターミナルが処理を終えると、**その行に印が付く**
- ストリップの配色は**エディタのテーマに追従**（ライト / ダークの固定も可）

## 動作環境

| | |
|---|---|
| macOS | Apple Silicon / Intel。日常的に使っているのはこれ |
| Windows | x64 でビルドとインストーラの作成を確認 |
| Linux | ビルド経路（deb / rpm / tar）は上流のまま残してあるが、**実機では未確認** |

## 入手とビルド

**バイナリは配布していません。ソースからビルドしてください。**
初回は 20〜40 分と、数 GB のディスクが要ります。

### 前提

上流の [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) と同じです。

- Node.js — 版は [`.nvmrc`](.nvmrc) のとおり
- Python 3、Git
- C/C++ のビルドツール（macOS は Xcode Command Line Tools、Windows は Visual Studio Build Tools、
  Linux は `build-essential`、`libx11-dev`、`libxkbfile-dev`、`libsecret-1-dev` など）

ネイティブモジュールをその場でコンパイルするため、**クロスビルドはできません。**
使う OS・アーキテクチャの上でビルドしてください。

### macOS

```bash
npm ci
npm run gulp vscode-darwin-arm64     # Intel なら vscode-darwin-x64
```

`../VSCode-darwin-arm64/BundleCode.app` ができます。`/Applications` へ移して使ってください。
署名していないので初回起動は Gatekeeper に止められます。Finder で右クリック →「開く」、
またはシステム設定の「プライバシーとセキュリティ」から許可してください。

### Windows

```powershell
npm ci
npm run gulp vscode-win32-x64
npm run gulp vscode-win32-x64-user-setup    # .build\win32-x64\user-setup\ にインストーラ
```

### Linux

```bash
npm ci
npm run gulp vscode-linux-x64               # ../VSCode-linux-x64/
npm run gulp vscode-linux-x64-build-deb     # .build/linux/deb/ に .deb
```

### ソースから直接起動する

ビルドを待たずに試すなら:

```bash
npm ci
npm run watch          # 別のターミナルで回し続ける
./scripts/code.sh
```

### キーチェーンの確認が出ることについて

サインインなどの秘密は、OS のキーチェーンに置いた鍵で暗号化して保存します。macOS では
`BundleCode Safe Storage` という項目が作られます。VS Code や Chrome など Electron の
アプリが等しくやっていることで、BundleCode に固有のものではありません。

**自分でビルドしたものは、焼き直すたびに「キーチェーンへのアクセスを許可しますか」と
訊かれます。** `npm run gulp` が作るアプリは ad-hoc 署名で、同一性が中身のハッシュしか
無いため、ビルドし直すと macOS が別のアプリと見なすからです。配布されている VS Code で
これが起きないのは、あちらが安定した署名（Team ID）を持っているからで、**VS Code を
自分でビルドしても同じことが起きます。**

気になる場合の選択肢は 3 つです。

- **そのまま「常に許可」**を押す。無害ですが、次にビルドし直すとまた訊かれます
- **`--use-inmemory-secretstorage` を付けて起動する。** キーチェーンに触れないので訊かれま
  せんが、**秘密はメモリにしか残らない**ので、起動のたびにサインインし直しになります
- **Apple Developer の証明書を持っているなら署名する。** `codesign --force --deep --sign
  "Apple Development: …" BundleCode.app` で、以後は訊かれなくなります

なお、これは Gatekeeper に止められる話（上記）とは別のものです。

## 使い方

起動すると左端にストリップが出ます。普段の VS Code の操作はそのままで、ストリップだけが
増えた形です。

### 一覧に載せる

**フォルダーを開いただけでは一覧に載りません。** 開いただけのウィンドウは一時的な行として
斜体で出ます。残したいものだけ、次のいずれかで登録します。

- ストリップの **＋フォルダー** からフォルダーを選ぶ
- 一時的な行を**右クリック →「一覧に追加」**
- 一時的な行を**ダブルクリックして名前を付ける**（付けた時点で一覧に入る）

開いたものを全部残すと「整理する場所」が「開いた履歴」になってしまうので、こうしています。

### ストリップの操作

| 操作 | 動作 |
|---|---|
| 行をクリック | 開いていれば切り替え、閉じていれば開く |
| 開いている行の × | ウィンドウを閉じる（`⌘W` と同じ経路。未保存なら確認が出る）。行は残る |
| 閉じている行の × | 一覧から削除 |
| 開いている行の ↻ | ウィンドウを再読み込み。リモートが固まったときの第一手 |
| ダブルクリック | 名前を変更 |
| ドラッグ | 並べ替え。グループ行の中央に落とすとグループへ入る |
| 右クリック | 一覧への追加・削除、ウィンドウの再読み込み・終了、グループの削除 |
| グループ行をクリック | 開閉 |
| 右端の帯をドラッグ | 幅を変更（140〜600px） |

上段のトグル、または `⌘⌃B`（Windows / Linux は `Ctrl+Alt+B`）で一覧を畳めます。畳んでも
操作のアイコンは細いレールとして残ります。

下段のアイコンは左から、**＋フォルダー**、**グループを作る**、**最近使った順**、
**SSH で接続**、**絞り込み**、**設定**です。

### 最近使った順

並べ替えボタンを押すと、一覧が最後に切り替えた順になります。押されたままの状態が残り、
もう一度押すと自分で並べた順に戻ります。このあいだグループは平らになり、ドラッグでの
並べ替えとグループの新規作成はできません。

行を押した瞬間に並びが変わると指の下から行が逃げるので、**並べ直しはポインタがストリップから
離れてから**反映されます。

### 絞り込み

虫めがね、または `⌘⌃F`（`Ctrl+Alt+F`）。名前とパスの両方に当たります。`Enter` で先頭の
一致を開いて欄を閉じ、`Esc` で閉じます。閉じると絞り込みも解けます。

### グループ

グループを作ると名前の入力状態で現れるので、そのまま名前を打ってください。
プロジェクトはドラッグ、または設定ウィンドウのプルダウンでグループへ移せます。
グループを削除しても中のプロジェクトは消えず、最上位に戻ります。

### 設定ウィンドウ

歯車から開きます。プロジェクトとグループの名前・所属・並び順の編集、ストリップの配色
（エディタに合わせる / ライト / ダーク）の切り替えができます。

一覧そのものは `settings.json` と同じ場所の **`bundlecode.json`** に保存されています。
手で編集しても構いません。

### SSH 先のワークスペース

`><` を押すと `~/.ssh/config` のホストが並びます（最近つないだものが先頭）。選ぶとそのホストに
つないだ空のウィンドウが開くので、そこでフォルダーを開いてください。以後はそのフォルダーが
普通のプロジェクトとして一覧に載り、行から直接開けます。

接続には拡張機能 `jeanp413.open-remote-ssh` が必要です。また接続先に置くサーバーを自分で
どこかに置き、`remote.SSH.serverDownloadUrlTemplate` をそこへ向ける必要があります。
サーバーは `npm run gulp vscode-reh-linux-x64` などで作れます（接続先と同じ OS 上で）。

### 呼んでいるプロジェクトの印

隠れているプロジェクトのターミナルが**ベルを鳴らす**と、その行の点が琥珀色になります。
見れば消えます。ベルを鳴らすのはターミナルの側なので、長い処理の終わりに `printf '\a'` を
付けるか、使っているツールの「ベルで通知」設定を有効にしてください。

### 設定

| 設定 | 内容 |
|---|---|
| `bundleCode.update.check` | 新しい版の通知を出すか（`markerUrl` を設定した場合のみ意味がある） |
| `bundleCode.update.markerUrl` | 配布物の情報（JSON）の URL。**自分でビルドして使う分には不要** |

自動更新はありません。

## 拡張機能

拡張機能は [Open VSX](https://open-vsx.org/) から入ります。Microsoft の Marketplace は
規約で公式ビルド以外からの利用を禁じているため使えません（VSCodium と同じ事情です）。

そのため、**Microsoft が Marketplace だけで配っている拡張機能は入りません。**
Remote - SSH、Live Share、C# Dev Kit、Pylance などがこれに当たります。
リモート接続は上記のとおり `jeanp413.open-remote-ssh` で代替できます。

## 仕組み

```
BrowserWindow（ホスト 1 枚）
├── WebContentsView ← ストリップ
├── WebContentsView ← workbench A（ワークスペース A + 専用の拡張ホスト）
├── WebContentsView ← workbench B（非表示）
└── WebContentsView ← workbench C（非表示）
```

`CodeWindow` は `electron.BrowserWindow` を要求するので、各タブには `BrowserWindow` に見える
Proxy を渡しています。コンテンツ系の呼び出しは自分のビューへ、ウィンドウ系はホストへ振り分け、
未知の呼び出しはホストへ落とします。

上流への変更は次の範囲に収めてあります。

| | |
|---|---|
| `src/vs/platform/windows/electron-main/bundle*.ts` | ホスト・ストリップ・設定ウィンドウ・SSH ホスト一覧 |
| `src/vs/workbench/contrib/bundle/` | workbench 側の貢献（テーマ連携、通知、更新通知） |
| `windowImpl.ts` / `windowsMainService.ts` / `app.ts` | ウィンドウの代わりにタブを作る配線 |
| `product.json` / `resources/` / `build/win32/code.iss` / `resources/linux/` | ブランドとパッケージ情報 |

## 問題の報告と貢献

- 不具合や提案は [Issues](https://github.com/himeno/BundleCode/issues) へ
- **脆弱性は Issue に書かないでください。** 手順は [SECURITY.md](SECURITY.md) に
- 変更を送る前に [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください

## ライセンス

[MIT](LICENSE.txt)。上流 Code - OSS の著作権表示（Microsoft Corporation）を残したうえで、
BundleCode の変更分を同じライセンスで公開しています。同梱している第三者のライセンスは
[ThirdPartyNotices.txt](ThirdPartyNotices.txt) を参照してください。

アイコンは自作で、元の SVG は [`resources/bundlecode-icon.svg`](resources/bundlecode-icon.svg) にあります。

## 免責事項

- Microsoft および VS Code チームとは無関係の、個人によるフォークです
- "Visual Studio Code" の名前と VS Code のアイコンは Microsoft の商標で、このリポジトリには含まれません
- 動作の保証はありません。利用は自己責任でお願いします
- 拡張機能の互換性は Code - OSS と同等ですが、Microsoft の Marketplace は利用できません
