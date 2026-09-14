/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { BUNDLE_UPDATE_PROGRESS_CHANNEL, IBundleUpdateProgress } from '../../../../platform/windows/common/bundleUpdate.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

const enum BundleUpdateSetting {
	Check = 'bundleCode.update.check',
	MarkerUrl = 'bundleCode.update.markerUrl',
	Source = 'bundleCode.update.source'
}

/**
 * The value comes from `product.json`, which the release script fills in when
 * it bakes a build: a build meant for other people and one meant for this
 * machine must not read the same marker, or publishing a private build would
 * tell every public installation that an update is waiting. The source carries
 * no default — without a configured URL the checker stays quiet.
 *
 * Read through a cast rather than by widening `IProductConfiguration`, which is
 * an upstream file. The rebase surface is worth more than the type.
 */
function markerUrlFor(productService: IProductService): string | undefined {
	return (productService as { bundleCodeUpdateMarkerUrl?: string }).bundleCodeUpdateMarkerUrl;
}

/** Roughly a working day, so a machine left running still notices. */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * What `bundlecode-release.sh --dist` publishes. Only `date` decides whether an
 * update exists; the rest is for what the notification says.
 */
interface IBundleUpdateMarker {
	readonly date?: string;
	readonly version?: string;
	readonly revision?: string;
	/** Base name of the disk image, which carries the architecture it was baked for. */
	readonly artifact?: string;
	/**
	 * Where the build can be downloaded, when it is published somewhere a browser
	 * can reach. Builds handed over between two of my own machines are not, and
	 * for those the notification falls back to spelling out the copy.
	 */
	readonly url?: string;
}

/**
 * Tells the user when a newer build exists, and fetches it when asked.
 *
 * The workbench's own update service is still off: `product.json` carries no
 * `updateUrl`, and Squirrel.Mac wants a zip served from an endpoint that answers
 * in its own shape, which a file attached to a release is not. So the fetching is
 * done here and the swapping by the host, which is the only part of this that
 * outlives the process being replaced.
 *
 * The comparison is `product.date`, which the build fills in from the commit date
 * of `HEAD` rather than the wall clock. The commit itself cannot be used: it is
 * pinned to the upstream merge base so that one REH server keeps serving every
 * build, which means it does not move when the fork does.
 */
class BundleUpdateChecker extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bundleUpdateChecker';

	/**
	 * An update is running somewhere in the application. Mirrors the host's one
	 * piece of state; this side never decides it.
	 */
	private running = false;

	/** Which build is coming, for the text. Unknown in a tab that did not ask. */
	private pending = '';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();

		// A build made from an uncommitted tree has nothing to compare against.
		if (!this.productService.date) {
			this.logService.trace('bundleUpdate: no build date in product.json, not checking');
			return;
		}

		// **どのタブもこれを動かす。**入れ替わるのはアプリ 1 つなので、走っている
		// 更新も 1 つ。ホストの配信をどのタブも聞いておき、押していないタブでも
		// 進み具合が見え、走っている間は二度目を持ちかけない。
		this._register(this.listen());

		// 配信は起きた瞬間にしか流れない。更新の途中で開かれたタブはそれを聞いて
		// いないので、自分から一度訊く。
		console.log('bundle:' + JSON.stringify({ cmd: 'updateStatus' }));

		this.check();

		this._register(disposableWindowInterval(mainWindow, () => this.check(), CHECK_INTERVAL));
	}

	/**
	 * Follows the one update the host is running, from whichever tab started it.
	 *
	 * The status bar entry belongs to this window, so each tab makes its own and
	 * they all say the same thing. What must not be per-tab is the offer: an
	 * update already running is not something to be asked about again.
	 */
	private listen(): IDisposable {
		const listener = (_event: unknown, ...args: unknown[]) => {
			const progress = args[0] as IBundleUpdateProgress;

			if (progress.stage === 'failed') {
				this.running = false;
				// 器を畳んでから伝える。項目を残したまま横に出すと、まだ動いて
				// いるように見える。
				this.entry.clear();
				this.notifyFailure(progress);
				return;
			}

			this.running = true;
			if (progress.version) {
				this.pending = progress.version;
			}
			const text = this.describe(progress);
			const item = {
				name: localize('bundleUpdateStatusName', "BundleCode Update"),
				text: `$(cloud-download) ${text}`,
				ariaLabel: text
			};

			if (this.entry.value) {
				(this.entry.value as IStatusbarEntryAccessor).update(item);
			} else {
				this.entry.value = this.statusbarService.addEntry(item, 'bundleCode.update', StatusbarAlignment.LEFT, 10);
			}
		};

		ipcRenderer.on(BUNDLE_UPDATE_PROGRESS_CHANNEL, listener);
		return toDisposable(() => ipcRenderer.removeListener(BUNDLE_UPDATE_PROGRESS_CHANNEL, listener));
	}

	private async check(): Promise<void> {
		if (!this.configurationService.getValue<boolean>(BundleUpdateSetting.Check)) {
			return;
		}

		const url = this.configurationService.getValue<string>(BundleUpdateSetting.MarkerUrl) || markerUrlFor(this.productService);
		if (!url) {
			this.logService.trace('bundleUpdate: no marker url configured, not checking');
			return;
		}

		let marker: IBundleUpdateMarker | null;
		try {
			// **キャッシュを通さない。** この読みは renderer の `fetch` で出ていて、
			// あれはブラウザと同じ蓄えを持つ。`Cache-Control` に従って手元の写しを
			// 返したり、条件付きで訊いて `304` を受けたりする。マーカーが答えるのは
			// 「今どうなっているか」で、前に聞いた話で代えられては用を成さない——
			// X 側では実際に、置き換えた版に半日気付かないまま「更新なし」と
			// 言い続けた。`raw.githubusercontent.com` も `Cache-Control` を返すので、
			// こちらで起きない理由が無い。
			const context = await this.requestService.request({ type: 'GET', url, disableCache: true, callSite: 'bundleUpdateChecker.check' }, CancellationToken.None);

			// 304 は失敗ではない。上の `disableCache` で自分の蓄えからは来なくなるが、
			// 間に立つものが返すことはある。**そのときは「変わっていない」が答え**
			// であって、読めなかったのとは違う。`asJson` は 200 台以外を投げ、投げた
			// 先は「オフラインだろう」と黙って諦めるので、一緒くたにすると成功を
			// 握り潰すことになる。
			if (context.res.statusCode === 304) {
				this.logService.trace('bundleUpdate: the marker has not changed');
				return;
			}

			marker = await asJson<IBundleUpdateMarker>(context);
		} catch (error) {
			// Being offline is the common case, so this stays out of the user's way.
			this.logService.trace('bundleUpdate: could not read the marker', error);
			return;
		}

		if (!marker?.date) {
			this.logService.trace('bundleUpdate: the marker carries no date');
			return;
		}

		const published = Date.parse(marker.date);
		const running = Date.parse(this.productService.date!);
		if (isNaN(published) || isNaN(running) || published <= running) {
			return;
		}

		// 走っているものがあるなら黙る。どのタブも同じ新しい版を見つけるので、
		// ここで止めないとタブの数だけ同じ誘いが出る。
		if (this.running) {
			return;
		}

		this.notify(marker);
	}

	private notify(marker: IBundleUpdateMarker): void {
		const built = marker.date ? new Date(marker.date).toLocaleString() : '';
		const version = marker.version ?? this.productService.version;

		// A published build can just be fetched, so offer the fetch. Only when the
		// marker names nowhere to get it does the notification fall back to
		// spelling out the copy between two machines of my own.
		const get = marker.url
			? {
				label: localize('bundleUpdateInstall', "Download and Install"),
				run: () => { this.install(marker.url!, version); }
			}
			: {
				label: localize('bundleUpdateCopy', "Copy Install Commands"),
				run: () => this.clipboardService.writeText(this.installCommands(marker))
			};

		this.notificationService.prompt(
			Severity.Info,
			localize('bundleUpdateAvailable', "BundleCode {0} is available, built {1}.", version, built),
			[get, {
				label: localize('bundleUpdateNever', "Stop Checking"),
				run: () => this.configurationService.updateValue(BundleUpdateSetting.Check, false)
			}]
		);
	}

	/**
	 * Fetches the build and hands it to the host, which does the swapping.
	 *
	 * Only the asking happens here. A renderer is a web page, so its requests are
	 * cross-origin, and a release asset answers without the header that would
	 * allow one — the marker allows it, which is why reading the marker worked and
	 * fetching what it pointed at did not. The host has Electron's own stack and
	 * no such rule, and it is the side that has to outlive the swap anyway.
	 */
	private install(url: string, version: string): void {
		// 表示は組み立てない。ホストが配信を始め、それを listen が拾う——押した
		// タブも押していないタブも、同じ経路で同じものを見る。
		this.running = true;
		this.pending = version;
		console.log('bundle:' + JSON.stringify({ cmd: 'installUpdate', url, version }));
	}

	/**
	 * Says that it did not finish, and offers to carry on.
	 *
	 * **What was fetched is still there**, named after the build rather than the
	 * clock, so pressing this picks up from wherever it stopped instead of
	 * starting over. A dropped connection part way through half a gigabyte is an
	 * ordinary event on a home line, and starting over each time is how a slow
	 * link never finishes at all.
	 */
	private notifyFailure(progress: IBundleUpdateProgress): void {
		const url = progress.url;
		this.notificationService.prompt(
			Severity.Warning,
			progress.message
				? localize('bundleUpdateFailedWhy', "Could not finish updating {0}: {1}", this.productService.nameLong, progress.message)
				: localize('bundleUpdateFailed', "Could not finish updating {0}.", this.productService.nameLong),
			url
				? [{
					label: localize('bundleUpdateResume', "Resume"),
					run: () => { this.install(url, this.pending || this.productService.version); }
				}]
				: []
		);
	}

	private describe(progress: IBundleUpdateProgress): string {
		switch (progress.stage) {
			case 'downloading':
				return localize('bundleUpdateProgressDownloading', "Downloading {0}: {1}%", this.pending, Math.round((progress.fraction ?? 0) * 100));
			case 'verifying':
				return localize('bundleUpdateProgressVerifying', "Checking {0}…", this.pending);
			case 'installing':
				// The window is about to go, so this is the last thing it says.
				return localize('bundleUpdateProgressInstalling', "Installing {0}, restarting…", this.pending);
			case 'failed':
				return localize('bundleUpdateProgressFailed', "Update failed");
		}
	}

	/**
	 * The app itself is not published, so there is nothing to download from here.
	 * What the user needs is the two commands that fetch it from whichever machine
	 * baked it and hand it to the installer.
	 */
	private installCommands(marker: IBundleUpdateMarker): string {
		const source = this.configurationService.getValue<string>(BundleUpdateSetting.Source);
		const name = marker.artifact;

		if (!name) {
			return `# The marker at ${this.configurationService.getValue<string>(BundleUpdateSetting.MarkerUrl)} names no artifact.`;
		}

		if (!source) {
			return [
				`# ${BundleUpdateSetting.Source} is not set, so the machine that baked ${name} is unknown.`,
				`# Set it to something like user@host:/path/to/BundleCode, then run this again.`
			].join('\n');
		}

		return [
			`scp '${source}/${name}.dmg' '${source}/bundlecode-install.sh' ~/Downloads/`,
			`bash ~/Downloads/bundlecode-install.sh ~/Downloads/${name}.dmg`
		].join('\n');
	}
}

registerWorkbenchContribution2(BundleUpdateChecker.ID, BundleUpdateChecker, WorkbenchPhase.Eventually);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'bundleCode',
	order: 8,
	title: localize('bundleCodeConfigurationTitle', "BundleCode"),
	type: 'object',
	properties: {
		[BundleUpdateSetting.Check]: {
			type: 'boolean',
			default: true,
			description: localize('bundleCodeUpdateCheck', "Report when a newer BundleCode build has been published. The build is never installed automatically.")
		},
		[BundleUpdateSetting.MarkerUrl]: {
			type: 'string',
			// Empty so that the build's own value is used unless someone overrides it.
			default: '',
			description: localize('bundleCodeUpdateMarkerUrl', "Where to read the published build's details from. Only the build date is compared.")
		},
		[BundleUpdateSetting.Source]: {
			type: 'string',
			default: '',
			description: localize('bundleCodeUpdateSource', "Where the built app is kept, as an scp source such as `user@host:/path/to/BundleCode`. Used to spell out the install commands.")
		}
	}
});
