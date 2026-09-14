/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

/**
 * An OSC sequence ends in BEL, and a shell sets the window title through one on
 * every prompt. Searching the stream for BEL without taking these out would
 * report a bell after every command that runs.
 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const BELL = '\x07';

/** A run of bells says no more than one does. */
const QUIET_PERIOD = 1000;

/**
 * How long the stream has to stay quiet before the work counts as over.
 *
 * An agent pausing to think, or a build between two noisy steps, prints nothing
 * for a moment without having stopped. Too short and the dot flickers through
 * every one of those; too long and it keeps breathing after the work is done.
 * Longer than one turn of the pulse, so the dot is never caught mid-breath.
 */
const IDLE_PERIOD = 2000;

/**
 * How long output has to have been flowing for its stopping to be worth marking.
 *
 * Work stopping is the same event as work finishing, so the strip can say a
 * project is done without anything having to announce it. What that costs is a
 * mark after every command, so the run has to have been long enough to have been
 * walked away from: nobody leaves the desk over an `ls`, and nobody watches an
 * agent think for a minute either.
 */
const WORTH_MARKING = 5000;

/**
 * Marks a project on the strip when something in its terminals rings the bell.
 *
 * Long running work in a hidden tab finishes unnoticed, which is the whole
 * problem with putting several workspaces behind one window. The bell is what a
 * command already emits when it wants attention, so nothing has to know that
 * Claude Code, a build or a test run is what produced it.
 *
 * Read from the pty stream rather than from the terminal's own bell status. That
 * status is only raised when `terminal.integrated.enableBell` is on, which is
 * off by default and is really a question about whether to make a noise, not
 * about whether anything happened. The stream carries the bell either way, and
 * carries it for remote terminals too.
 *
 * The strip lives in the main process and this runs in a renderer with no handle
 * on it, so the mark travels the way the strip's own pages already talk: a
 * console message the host reads through `console-message`. The host knows which
 * view the message came from, so the renderer does not have to say which project
 * it is. Clearing is the host's business too, since only it knows when a tab has
 * been looked at.
 *
 * The bell is not the only way a project gets marked, and turned out not to be
 * the reliable one. Whether it rings at the end of a run is the agent's business
 * and its setting, and a run that ends without one still ended. Output stopping
 * after it had been going a while says the same thing and says it for anything
 * that prints, so that is the other way in. The bell stays because it can come
 * mid-run, where nothing has stopped to notice.
 *
 * The same channel carries whether any terminal here is busy, which is a
 * different question: the bell is a moment, this is a state. It is read off the
 * same stream, as output arriving and then stopping.
 *
 * `hasChildProcesses` is what the integrated terminal's own tabs use and is the
 * more literal answer, but it answers a question nobody is asking here. An agent
 * CLI is itself a child of the shell, so it holds that flag up from the moment it
 * starts until it is quit, which says the terminal is occupied rather than that
 * anything is happening in it. Output is the thing that actually tracks the work.
 */
class BundleAttention extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bundleAttention';

	private lastReported = 0;

	/** Keystrokes come one at a time; the host only needs to hear this once. */
	private lastLooked = 0;

	/** When output last arrived, from any terminal in this window. */
	private lastOutput = 0;
	/** When the run in progress first started printing. */
	private runStarted = 0;
	private running = false;
	private readonly idle = this._register(new MutableDisposable<IDisposable>());

	constructor(@ITerminalService terminalService: ITerminalService) {
		super();

		this._register(terminalService.onAnyInstanceData(({ data }) => {
			this.sawOutput();

			// Every chunk of every terminal arrives here, so the cheap test comes
			// first and the sequence stripping only runs for the few that carry a
			// BEL at all.
			if (!data.includes(BELL) || !data.replace(OSC_SEQUENCE, '').includes(BELL)) {
				return;
			}

			this.markAttention();
		}));

		// Typing here answers the request for attention. The host clears it when a
		// tab is switched to, which is the only answer it can see on its own, and
		// the tab already on screen never gets switched to.
		this._register(terminalService.onAnyInstanceDataInput(() => {
			const now = Date.now();
			if (now - this.lastLooked < QUIET_PERIOD) {
				return;
			}
			this.lastLooked = now;

			console.log('bundle:' + JSON.stringify({ cmd: 'looked' }));
		}));
	}

	/**
	 * Which terminal the output came from does not matter: the strip marks the
	 * project, and how many of its terminals are working is not something it
	 * shows.
	 */
	private sawOutput(): void {
		this.lastOutput = Date.now();
		if (!this.running) {
			this.runStarted = this.lastOutput;
		}
		if (this.running) {
			// The timer is already ticking and reads `lastOutput` when it fires,
			// so there is nothing to put off here. Chunks arrive far too fast
			// during a stream to be tearing down a timeout on each one.
			return;
		}
		this.running = true;
		this.report();
		this.waitForQuiet();
	}

	/**
	 * Sleeps until the stream could first have been quiet long enough, rather
	 * than waking on a fixed tick: while output is flowing this fires once every
	 * {@link IDLE_PERIOD} at worst, no matter how much of it there is.
	 */
	private waitForQuiet(): void {
		const quietFor = Date.now() - this.lastOutput;
		if (quietFor >= IDLE_PERIOD) {
			this.running = false;
			this.report();

			// Measured to where the output actually stopped, not to now: the wait
			// that proved it had stopped is not part of the run.
			if (this.lastOutput - this.runStarted >= WORTH_MARKING) {
				this.markAttention();
			}
			return;
		}
		this.idle.value = disposableTimeout(() => this.waitForQuiet(), IDLE_PERIOD - quietFor);
	}

	private report(): void {
		console.log('bundle:' + JSON.stringify({ cmd: 'running', value: this.running }));
	}

	/**
	 * Both ways of noticing come through here, since a bell at the end of a long
	 * run would otherwise mark the project twice.
	 */
	private markAttention(): void {
		const now = Date.now();
		if (now - this.lastReported < QUIET_PERIOD) {
			return;
		}
		this.lastReported = now;

		console.log('bundle:' + JSON.stringify({ cmd: 'attention' }));
	}
}

registerWorkbenchContribution2(BundleAttention.ID, BundleAttention, WorkbenchPhase.Eventually);
