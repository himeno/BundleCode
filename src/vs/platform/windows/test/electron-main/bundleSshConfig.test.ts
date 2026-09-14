/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { collectSshHosts } from '../../electron-main/bundleSshConfig.js';

suite('BundleSshConfig', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Reads from a map of path to contents, so nothing touches a disk. */
	function hosts(files: Record<string, string>, entry = '/home/u/.ssh/config'): string[] {
		return collectSshHosts(path => files[path], entry, '/home/u');
	}

	test('takes the names and leaves the patterns', () => {
		assert.deepStrictEqual(hosts({
			'/home/u/.ssh/config': [
				'Host *',
				'  ForwardAgent yes',
				'',
				'# a comment, and a keyword that is not Host',
				'Host build web',          // several names on one line
				'  HostName 192.0.2.1',
				'Host=equals.example',     // ssh accepts Keyword=value
				'  User root',
				'host lowercase.example',  // keywords are case insensitive
				'Host i-*',                // a fleet, not a machine
				'Host !excluded',          // a negation, not a machine
				'Host build'               // already seen
			].join('\n')
		}), ['build', 'web', 'equals.example', 'lowercase.example']);
	});

	test('follows Include and survives a ring of them', () => {
		assert.deepStrictEqual({
			relative: hosts({
				'/home/u/.ssh/config': 'Host first\nInclude work\n',
				'/home/u/.ssh/work': 'Host second\n'
			}),
			tilde: hosts({
				'/home/u/.ssh/config': 'Include ~/elsewhere/more\n',
				'/home/u/elsewhere/more': 'Host third\n'
			}),
			cycle: hosts({
				'/home/u/.ssh/config': 'Host a\nInclude other\n',
				'/home/u/.ssh/other': 'Host b\nInclude config\n'
			}),
			glob: hosts({
				'/home/u/.ssh/config': 'Host a\nInclude conf.d/*\n'
			}),
			missing: hosts({})
		}, {
			relative: ['first', 'second'],
			tilde: ['third'],
			cycle: ['a', 'b'],
			glob: ['a'],
			missing: []
		});
	});
});
