/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/bundleStrip.css';
import './bundleUpdate.contribution.js';
import './bundleAttention.contribution.js';
import './bundleTheme.contribution.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

/**
 * The codicon passed here is only a placeholder: `registerIcon` insists on a
 * font character, and the artwork arrives from `bundleStrip.css` instead. It is
 * never seen, but a related shape keeps the fallback sane if that rule is ever
 * dropped.
 */
const bundleStripIcon = registerIcon('bundle-strip', Codicon.layoutActivitybarLeft,
	localize('bundleStrip', "Represents the project strip along the window's left edge"));

/**
 * Shows and hides the project strip from the title bar, next to the workbench's
 * own layout toggles.
 *
 * The strip belongs to the main process, and this runs in a renderer that has no
 * handle on it. Rather than stand up a channel for one boolean, the click goes
 * out the way the strip's own pages already talk: a console message the host
 * picks up through `console-message`. Cmd+Ctrl+B keeps working through the
 * host's `before-input-event` hook, which is why no keybinding is declared here
 * — two paths to the same toggle would cancel each other out.
 */
registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'bundleCode.toggleStrip',
			title: localize2('toggleBundleStrip', "Toggle Project Strip"),
			category: Categories.View,
			icon: bundleStripIcon,
			f1: true,
			menu: [{
				id: MenuId.LayoutControlMenu,
				group: 'navigation',
				order: -1 // Left of the workbench's own toggles, matching the layout.
			}]
		});
	}

	run(): void {
		console.log('bundle:' + JSON.stringify({ cmd: 'toggle' }));
	}
});
