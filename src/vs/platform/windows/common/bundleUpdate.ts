/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the host says while it is replacing the app, and the name it says it under.
 *
 * Kept here rather than beside the code that sends it, so that the window can
 * read the shape without reaching into `electron-main`. The two ends only agree
 * on a string and an object, and this is where that agreement is written down.
 */

export const BUNDLE_UPDATE_PROGRESS_CHANNEL = 'vscode:bundleUpdateProgress';

/**
 * `stage` rather than a bare fraction because most of the wait is not the
 * download. Verifying half a gigabyte takes a while and replacing it takes
 * longer, and both looked like a hang when nothing said otherwise.
 */
export interface IBundleUpdateProgress {
	readonly stage: 'downloading' | 'verifying' | 'installing' | 'failed';
	/** 0–1 while downloading, absent otherwise. */
	readonly fraction?: number;
	readonly message?: string;
	/**
	 * Which build is coming. Carried on every message because a tab opened part
	 * way through never saw the notification that named it, and a tab that did
	 * not press the button never knew it either.
	 */
	readonly version?: string;
	/**
	 * Where it was being fetched from, on `failed` only, so that the offer to
	 * carry on can be made.
	 *
	 * **Every tab is told about the failure**, and all but one of them never had
	 * the URL — it arrived in a marker that tab read and a button that tab
	 * pressed. Without this, the window showing the bad news is usually not the
	 * window able to do anything about it.
	 */
	readonly url?: string;
}
