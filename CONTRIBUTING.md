# 貢献について / Contributing

BundleCode は個人が保守しているフォークです。歓迎しますが、返事が遅いことはあります。

## Issue

- 不具合は、**再現手順・OS・ビルドした commit**（`bcode --version`）を添えてください
- 上流 Code - OSS でも起きる問題は、[microsoft/vscode](https://github.com/microsoft/vscode/issues) の
  方へ報告してください。ここで直しても上流追随で戻ってしまいます
- 脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の手順で

## Pull Request

- 大きな変更は、先に Issue で方向を相談してください。設計の理由を共有してから手を動かす方が、
  お互いの時間を無駄にしません
- 変更は BundleCode が追加した部分（`README.md` の「上流への変更点」）に収めてください。
  上流のファイルへの改変は、上流追随のたびに衝突面になります
- コーディング規約は上流と同じです（`.github/copilot-instructions.md`）
- ライセンスは MIT です。送っていただいた変更も同じ条件で公開されます

---

BundleCode is a fork maintained by one person. Contributions are welcome; replies may be slow.
Please open an issue before large changes, keep changes within the fork's own files where
possible, and report upstream Code - OSS problems to microsoft/vscode. Contributions are
accepted under the MIT license.
