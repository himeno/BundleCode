/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { execFile, spawn } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { promisify } from 'util';
import { BUNDLE_UPDATE_PROGRESS_CHANNEL, IBundleUpdateProgress } from '../common/bundleUpdate.js';
import product from '../../product/common/product.js';

const run = promisify(execFile);

/**
 * Swaps the running app for a newer build the user just downloaded.
 *
 * An app cannot replace itself: whatever does the replacing has to outlive the
 * process being replaced, and everything started from here dies with it. So the
 * work is written out as a script, started detached, and left to wait for this
 * process to go away. That is the same shape `bundlecode-install.sh` has, for
 * the same reason.
 *
 * What this adds over the user doing it by hand is not the copying — it is
 * refusing to copy the wrong thing. A disk image fetched over the network is
 * checked against the signature the running app carries before anything is
 * touched, and the app it replaces is kept until the new one has started.
 */

/** How many times to pick the download back up before giving up on it. */
const RESUME_ATTEMPTS = 4;

/**
 * Fetches the build, picking up where it left off if the connection drops.
 *
 * This has to happen here rather than in the renderer, which is where it was
 * first put because that is where progress can be shown. A renderer is a web
 * page: its requests go through `fetch` from a `vscode-file://` origin, so they
 * are cross-origin, and a release asset answers without the header that would
 * allow one. The marker does allow it, which is why reading the marker worked
 * and fetching what it pointed at did not.
 *
 * `net` is Electron's own stack. It follows the redirect to the signed asset
 * URL, and it picks up the system proxy, neither of which the renderer's
 * `fetch` was going to be allowed to finish.
 *
 * **The resuming is not a nicety.** The image is close to half a gigabyte, and
 * the download is measured in minutes on a home connection — long enough that a
 * dropped connection is a normal event rather than an exceptional one. Starting
 * over each time is how a slow link never finishes at all.
 */
async function fetchTo(url: string, target: string, onProgress: (fraction: number) => void): Promise<void> {
	// **前回の途中までがあれば、そこから。** ここを 0 で始めると、下の
	// `createWriteStream` が既にあるものを切り詰めるので、名前を版で揃えた意味が
	// 無くなる——回線が切れて通知の Resume を押しても、また 0 から落とし直す。
	// 同じ名前のファイルは必ず同じ dmg の先頭部分なので、続きとして使ってよい。
	let from = await fs.stat(target).then(s => s.size, () => 0);
	let restarted = false;

	for (let attempt = 0; ; attempt++) {
		try {
			await fetchFrom(url, target, from, onProgress);
			return;
		} catch (error) {
			// 続きを断られたら、一度だけ先頭から取り直す。`Range` を読まない相手が
			// 出てくると、残っている途中ファイルが**二度と完成しない**状態に嵌まる
			// ——押すたびに同じところで断られるので、本人には直しようがない。
			if (error instanceof RangeRefusedError && !restarted) {
				restarted = true;
				from = 0;
				continue;
			}

			// 進んだ分だけは残っているので、そこから続ける。1 バイトも取れていない
			// なら止まっているのは回線ではなく相手なので、繰り返しても同じこと。
			const got = await fs.stat(target).then(s => s.size, () => 0);
			if (attempt >= RESUME_ATTEMPTS - 1 || got <= from) {
				throw error;
			}
			from = got;
		}
	}
}

/** 続きを求めたのに先頭から返された。取り直すしかない、の印。 */
class RangeRefusedError extends Error { }

/**
 * 1 回分の取得。`from` が 0 でなければ続きを求め、ファイルには追記する。
 *
 * 続きを求めたのに 200 が返ってきたら、相手は `Range` を読んでいない。そのまま
 * 追記すると**先頭からの中身が途中に混ざった壊れたファイル**ができ、しかも
 * 大きさだけは辻褄が合うので気付けない。だから 206 以外は拒む。
 */
function fetchFrom(url: string, target: string, from: number, onProgress: (fraction: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = electron.net.request(url);
		if (from > 0) {
			request.setHeader('Range', `bytes=${from}-`);
		}

		request.on('response', response => {
			// 416 は「その範囲は終わりの向こう」。手元にあるものが既に全部という
			// ことなので、取り直さずに次へ渡す。長すぎれば署名の確認が弾いて捨てる
			// ——自分で辻褄を合わせにいくより、通らないものを通さない方が確実。
			if (from > 0 && response.statusCode === 416) {
				resolve();
				return;
			}

			const wanted = from > 0 ? 206 : 200;
			if (response.statusCode !== wanted) {
				reject(from > 0 && response.statusCode === 200
					? new RangeRefusedError('取得先が続きからの要求を読みませんでした')
					: new Error(`ダウンロードできませんでした（HTTP ${response.statusCode}）`));
				return;
			}

			// 206 の `content-length` は残りの分でしかない。全体は `content-range` の
			// 分母にある。進捗が終盤から始まって見えるのを防ぐだけでなく、下の
			// 「取り切ったか」の判断もこれに乗っている。
			const range = /\/(\d+)\s*$/.exec(String(response.headers['content-range'] ?? ''));
			const total = from > 0
				? Number(range?.[1] ?? 0)
				: Number(response.headers['content-length'] ?? 0);
			let received = from;

			// ディスクへ流す。溜めてから書くと、半 GB のイメージが丸ごとメモリに乗り、
			// 書き出す瞬間はコピーができて倍になる。受け取る速さと書く速さの差は
			// パイプが面倒を見る。続きから取っているときは追記する。
			const file = createWriteStream(target, from > 0 ? { flags: 'a' } : undefined);
			const fail = (error: unknown) => {
				file.destroy();
				reject(error);
			};

			// 実体は Node の Readable だが、Electron の型はそう言っていない。流量を
			// 押さえるにはここが要るので、その 2 つだけを名指しで借りる。
			const flow = response as unknown as { pause(): void; resume(): void };

			response.on('data', chunk => {
				received += chunk.length;
				if (total > 0) {
					onProgress(received / total);
				}
				if (!file.write(chunk)) {
					flow.pause();
					file.once('drain', () => flow.resume());
				}
			});
			// **`end` は取り切った合図ではない。** 途中で切れた応答でもこれは来るので、
			// ここで数えずに resolve すると、半分だけのイメージを「落とせた」として
			// 次へ送ることになる。そこで初めて hdiutil が転ぶが、その頃には理由が
			// 「壊れた dmg」にしか見えない。大きさが分かっているなら突き合わせて、
			// 足りなければ投げる——上の再開がそれを拾う。
			response.on('end', () => file.end(() => {
				if (total > 0 && received < total) {
					reject(new Error(`ダウンロードが途中で切れました（${received} / ${total} バイト）`));
					return;
				}
				resolve();
			}));
			response.on('error', fail);
			file.on('error', fail);
		});

		request.on('error', reject);
		request.end();
	});
}

/**
 * 落とし先の名前。URL の末尾から作るので、同じ版なら何度呼んでも同じになる。
 *
 * 名前には空白が入りうる（`BundleCode X-…`）ので、パスとして素直な形に均す。
 * 一致さえすればよく、元の名前に戻せる必要はない。
 */
function imageName(url: string): string {
	const base = decodeURIComponent(url.split('/').pop() ?? 'image.dmg');
	return base.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** 今から落とすもの以外の途中ファイルを捨てる。 */
async function forgetOtherImages(keep: string): Promise<void> {
	try {
		const dir = tmpdir();
		for (const name of await fs.readdir(dir)) {
			if (!name.startsWith('bundlecode-update-')) {
				continue;
			}
			const path = join(dir, name);
			if (path !== keep) {
				await fs.rm(path, { force: true }).catch(() => { });
			}
		}
	} catch {
		// 掃除は本題ではない。読めなければ何もしない。
	}
}

/**
 * Tells the window what is happening.
 *
 * The host has the progress and no window to put it in; the workbench has the
 * window and knows nothing. The strip's messages only go the other way, so this
 * is sent straight to every renderer, and whoever is showing an update reads it.
 */
function report(progress: IBundleUpdateProgress): void {
	progress = { ...progress, version: progress.version ?? coming };
	// 進み具合はここが持つ。後から開いたタブは、始まったところを見ていないので
	// 配信を待っていても何も来ない——自分から訊いたときにこれを返す。
	// 終わった時点で手放し、次の更新を受けられる状態に戻す。
	inFlight = progress.stage === 'failed' ? undefined : progress;

	// タブは WebContentsView で BrowserWindow ではないので、窓を辿ると届かない。
	// 全部の webContents に投げて、更新を見せている側が拾う。
	for (const contents of electron.webContents.getAllWebContents()) {
		// 閉じかけのものに送ると投げる。更新の途中でタブを閉じるのは普通のことで、
		// ここで止まる理由にはしない。
		if (!contents.isDestroyed()) {
			contents.send(BUNDLE_UPDATE_PROGRESS_CHANNEL, progress);
		}
	}
}

/** Read the team the running app is signed with, or nothing when unsigned. */
async function teamOf(target: string): Promise<string | undefined> {
	try {
		// `codesign -dv` writes what it found to stderr, including for success.
		const { stderr } = await run('/usr/bin/codesign', ['-dv', target]);
		return /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Mounts the image and checks that what is inside is the same app, signed by the
 * same team, before anyone commits to replacing anything.
 *
 * An ad-hoc signature reports no team at all, so a build made without a
 * certificate cannot pass this even by accident. That is deliberate: the check
 * exists for the case where the marker or the download was tampered with, and a
 * missing team is exactly what tampering would produce.
 */
async function verify(image: string, appName: string, expectedTeam: string): Promise<string> {
	const { stdout } = await run('/usr/bin/hdiutil', [
		'attach', '-nobrowse', '-readonly', '-noverify', '-plist', image
	]);
	const mount = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(stdout)?.[1];
	if (!mount) {
		throw new Error('ディスクイメージをマウントできませんでした');
	}

	try {
		const app = join(mount, `${appName}.app`);
		await fs.access(app);

		// `--deep --strict` is what refuses a bundle whose insides were changed
		// after signing, which a plain `-dv` read would not notice.
		await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

		const team = await teamOf(app);
		if (team !== expectedTeam) {
			throw new Error(`署名の Team ID が違います（期待 ${expectedTeam}、実際 ${team ?? '無し'}）`);
		}
		return mount;
	} catch (error) {
		await run('/usr/bin/hdiutil', ['detach', '-quiet', mount]).catch(() => { });
		throw error;
	}
}

/**
 * The script that outlives us.
 *
 * It waits rather than assuming: the app is asked to quit through the normal
 * path so that unsaved work still prompts, which means the quit can be refused,
 * and it can also take a while when tabs hold remote connections. If the app is
 * still there when the wait runs out, the user said no, and nothing should be
 * replaced.
 */
function script(options: {
	readonly mount: string;
	readonly image: string;
	readonly installed: string;
	readonly appName: string;
	readonly bundleId: string;
	readonly userDataDir: string;
	readonly pid: number;
}): string {
	const { mount, image, installed, appName, bundleId, userDataDir, pid } = options;
	const backup = `${installed}.replacing`;
	return `#!/bin/bash
set -euo pipefail

# イメージは半 GB ある。どの経路で抜けても置いていかない——更新のたびに残ると、
# 気付かないうちに溜まっていく類のもの。外してからでないと消せない。
cleanup() {
	/usr/bin/hdiutil detach -quiet '${mount}' 2>/dev/null || true
	rm -f '${image}' "$0"
}
trap cleanup EXIT

# 終了を待つ。断られたら（未保存の確認でキャンセルされたら）何もしない。
for _ in $(seq 1 60); do
	/bin/kill -0 ${pid} 2>/dev/null || break
	sleep 1
done
if /bin/kill -0 ${pid} 2>/dev/null; then
	exit 0
fi

# 置き換えの最中に落ちても戻せるよう、消さずに退避する。
rm -rf '${backup}'
if [ -e '${installed}' ]; then
	mv '${installed}' '${backup}'
fi

# ditto でないと壊れる。.app はシンボリックリンクと framework 構造を持ち、
# それを保てないと署名が壊れて起動そのものが失敗する。
if ! /usr/bin/ditto '${mount}/${appName}.app' '${installed}'; then
	rm -rf '${installed}'
	[ -e '${backup}' ] && mv '${backup}' '${installed}'
	exit 1
fi

# ネットワーク越しに来たものには quarantine が付く。公証していないので、
# 外さないと初回起動がブロックされてシステム設定へ飛ばされる。
/usr/bin/xattr -dr com.apple.quarantine '${installed}' 2>/dev/null || true

# 古い登録が残っていると open -a が前の署名を掴む。
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f '${installed}' 2>/dev/null || true

# commit は上流のベースに固定してあるので、焼き直しても鍵が変わらず中身だけが
# 変わる。翻訳は文字列をインデックスの配列で持つため、捨てないと無関係な訳文が出る。
rm -rf '${userDataDir}/clp' '${userDataDir}/CachedData'

/usr/bin/open -b '${bundleId}' '${installed}' 2>/dev/null || /usr/bin/open '${installed}'

# **pgrep -f は使えない。** macOS のそれは長いパターンだと当たらない——実測で
# 40 文字までは当たり、44 文字で外れる。ここで渡すパスはその向こう側にあるので、
# 起動していても答えは常に「いない」になる。**そして「いない」はこの下で
# 「起動しなかった」と読まれ、入れたばかりの版を消して旧版に戻す。**成功した更新が
# 失敗した更新とまったく同じ姿になる、という壊れ方をする。
#
# ps を丸ごと受けてシェルで照合する。grep に渡すのも駄目で、grep 自身の引数がこの
# 名前を含むため、何も動いていなくても自分を見つけて「動いている」と答える。
running() {
	case "$(/bin/ps -Ao command=)" in
		*'${installed}/Contents/MacOS/'*) return 0 ;;
	esac
	return 1
}

# 起動を見届けてから退避を捨てる。立ち上がらなければ戻せる方が良い。
for _ in $(seq 1 30); do
	if running; then
		rm -rf '${backup}'
		exit 0
	fi
	sleep 1
done
rm -rf '${installed}'
[ -e '${backup}' ] && mv '${backup}' '${installed}'
/usr/bin/open '${installed}' 2>/dev/null || true
exit 1
`;
}

/**
 * Checks the download and hands the swap to something that will outlive us.
 * Returns once the app has been asked to quit; from there the script has it.
 */
/**
 * The one update in flight, or nothing.
 *
 * It lives here because the host is the only part that sees the whole
 * application. **Every tab runs its own workbench and therefore its own
 * checker**, so a window on each project all notice the same new build and all
 * offer it. Without something in the middle, taking the offer twice starts two
 * downloads of half a gigabyte and two swaps of the same bundle.
 *
 * Kept after it finishes as well, so a tab opened while one is running can be
 * told what is already happening instead of offering to start it again.
 */
let inFlight: IBundleUpdateProgress | undefined;

/** Name of the build being fetched, repeated on every message. */
let coming: string | undefined;

/** What a window should be told when it asks, having missed the broadcasts. */
export function updateInProgress(): IBundleUpdateProgress | undefined {
	return inFlight;
}

export async function installUpdate(url: string, version?: string): Promise<void> {
	// 二本目は断る。押したのが別のタブでも、入れ替わるのはアプリ 1 つなので
	// 同じ 1 件しか意味がない。
	//
	// **印は同期のうちに立てる。**この先には await があり、そこで手を離せば別の
	// タブの要求が入り込む。二つとも門を通れば、半 GB を二重に落として同じ
	// バンドルを二度置き換えにいく。
	if (inFlight) {
		return;
	}
	coming = version;
	inFlight = { stage: 'downloading', fraction: 0, version };

	try {
		await swap(url);
	} catch (error) {
		// **失敗も進み具合の一部として配る。** 以前は host がモーダルを出していたが、
		// あれは「読んで閉じる」しかできない——落とせた分は残っているのに、続きから
		// 取り直す道がどこにも出ない。通知にすれば押すだけで再開できる。
		//
		// `report` が `failed` を見て印を降ろす。降ろさないと、一度失敗したきり
		// 二度と更新できない。
		// 取得先も添える。失敗はどのタブにも届くが、URL を知っているのは押した
		// タブだけなので、添えないと**知らせを見た窓は再開できない窓**になる。
		report({ stage: 'failed', message: String((error as Error)?.message ?? error), url });
	}
}

async function swap(url: string): Promise<void> {
	// 渡ってくるのは JSON から出てきた値で、キャストは何も確かめていない。実際、
	// 送る側の名前を変えたときに受ける側が古いままになり、`undefined` がそのまま
	// `net.request` へ渡って ERR_CONNECTION_REFUSED になった——「行き先が無い」が
	// 「繋がらない」として出るので、原因が遠くに見える。ここで名指しで断る。
	if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
		throw new Error(`更新の取得先が https の URL ではありません: ${url}`);
	}

	const installed = electron.app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
	if (!installed.endsWith('.app')) {
		throw new Error('アプリの置き場所が分かりません');
	}

	const appName = installed.split('/').pop()!.replace(/\.app$/, '');
	const team = await teamOf(installed);
	if (!team) {
		// Nothing to check the download against. Refusing is the safe way round:
		// this path exists to install something, not to install anything.
		throw new Error('動いているアプリが Team ID を持たないので、更新を検証できません');
	}

	// Dock にも出す。ウィンドウを見ていないときはそちらが目に入るし、窓を持たない
	// この側が触れる唯一の表示でもある。
	const windows = electron.BrowserWindow.getAllWindows();
	const dock = (fraction: number) => windows.forEach(w => !w.isDestroyed() && w.setProgressBar(fraction));

	// **名前は版で決まる。時刻ではない。**
	//
	// 以前は `Date.now()` を使っていて、そのせいで取り直すたびに別のファイルに
	// なった。半 GB を落としている最中に回線が切れれば、そこまでの分はどこからも
	// 参照されないまま残り、次は 0 から。**同じ版なら同じ名前**にしておけば、
	// 上の `fetchTo` が向こうにある分を見て続きから取る。dmg は版で名前が
	// 決まっていて中身が変わらないので、途中まででも先頭部分として必ず正しい。
	const image = join(tmpdir(), `bundlecode-update-${imageName(url)}`);

	// 別の版の途中までが残っていたら捨てる。もう誰も取りに行かないものが
	// 半 GB ずつ溜まる。
	await forgetOtherImages(image);

	try {
		await fetchTo(url, image, fraction => {
			dock(fraction);
			report({ stage: 'downloading', fraction });
		});
	} catch (error) {
		dock(-1);
		// **落とせた分は残す。** ここで消すと、次に押したときまた 0 からになる。
		// 途中で切れたものは常に先頭からの一続きなので、置いておいて損はない。
		throw error;
	}

	// 弾いたイメージは置いていかない。**取得の失敗とは扱いが違う** — 途中で切れた
	// ものは同じファイルの正しい先頭だが、検証を通らなかったものは続きを取っても
	// 通らない。ここで投げると入れ替えは起きないので、掃除する相手はこの先の
	// スクリプトではなくこちら。
	report({ stage: 'verifying' });
	let mount: string;
	try {
		mount = await verify(image, appName, team);
	} catch (error) {
		dock(-1);
		await fs.rm(image, { force: true }).catch(() => { });
		throw error;
	}
	dock(-1);
	report({ stage: 'installing' });

	// The build's own identifier, so a differently branded build (or the
	// personal one) installs itself rather than a hard-coded sibling. Every
	// macOS build has one; a product.json without it cannot have been packaged.
	const bundleId = product.darwinBundleIdentifier;
	if (!bundleId) {
		throw new Error('product.json has no darwinBundleIdentifier');
	}

	const path = join(tmpdir(), `bundlecode-install-${process.pid}.sh`);
	await fs.writeFile(path, script({
		mount,
		image,
		installed,
		appName,
		bundleId,
		userDataDir: electron.app.getPath('userData'),
		pid: process.pid
	}), { mode: 0o700 });

	// detached ならプロセスグループが分かれるので、こちらが終了しても道連れに
	// ならない。unref しないと、こちらが終わるのを Node が待ってしまう。
	spawn('/bin/bash', [path], { detached: true, stdio: 'ignore' }).unref();

	// 通常の終了経路を通す。未保存があれば macOS が聞くので、断れば上のスクリプトは
	// 待ちきって何もせずに終わる。
	electron.app.quit();
}
