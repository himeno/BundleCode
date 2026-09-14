/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

/**
 * What the strip asks the theme for, named as the strip thinks of it. Anything
 * a theme leaves unset is dropped, and the strip keeps its own value: a colour
 * that is merely plausible is worse than one that was designed.
 */
const PALETTE: readonly { readonly variable: string; readonly id: string }[] = [
	{ variable: 'bg', id: 'sideBar.background' },
	{ variable: 'edge', id: 'sideBar.border' },
	{ variable: 'text', id: 'sideBar.foreground' },
	{ variable: 'dim', id: 'descriptionForeground' },
	{ variable: 'faint', id: 'descriptionForeground' },
	{ variable: 'hover', id: 'list.hoverBackground' },
	{ variable: 'icon', id: 'icon.foreground' },
	{ variable: 'icon-hover', id: 'toolbar.hoverBackground' },
	{ variable: 'accent', id: 'list.activeSelectionBackground' },
	{ variable: 'on-accent', id: 'list.activeSelectionForeground' },
	{ variable: 'rename-bg', id: 'input.background' },

	// Settings window. It is a window rather than a side bar, so its surfaces
	// come from the editor and its fields from the input controls.
	{ variable: 'panel', id: 'sideBar.background' },
	{ variable: 'window-bg', id: 'editor.background' },
	{ variable: 'field', id: 'input.background' },
	{ variable: 'field-edge', id: 'input.border' }
];

/**
 * Tells the strip how the editor beside it is painted.
 *
 * The strip is drawn by the main process and has no way to read a colour theme:
 * themes are resolved from extensions and settings that only a renderer has. So
 * the renderer reads them and passes the few colours the strip is built out of.
 *
 * Only sent, not obeyed. The strip applies these when it has been set to follow
 * along, and keeps its own palette when it has been told to be light or dark.
 * The colours that carry meaning rather than style — a project being open, a
 * project asking to be looked at — are not in the list, because no theme has an
 * opinion about them and a theme's accent standing in for them would say the
 * wrong thing.
 */
class BundleTheme extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.bundleTheme';

	constructor(@IThemeService themeService: IThemeService) {
		super();

		const report = (theme: IColorTheme) => {
			const light = theme.type === ColorScheme.LIGHT || theme.type === ColorScheme.HIGH_CONTRAST_LIGHT;

			const colors: Record<string, string> = {};
			for (const { variable, id } of PALETTE) {
				const color = theme.getColor(id);
				if (color) {
					colors[variable] = color.toString();
				}
			}

			console.log('bundle:' + JSON.stringify({ cmd: 'theme', kind: light ? 'light' : 'dark', colors }));
		};

		report(themeService.getColorTheme());
		this._register(themeService.onDidColorThemeChange(report));
	}
}

registerWorkbenchContribution2(BundleTheme.ID, BundleTheme, WorkbenchPhase.BlockRestore);
