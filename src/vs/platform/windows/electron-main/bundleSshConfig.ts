/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from '../../../base/common/path.js';

/** Where `ssh` looks unless told otherwise. */
export function defaultSshConfigPath(home = homedir()): string {
	return join(home, '.ssh', 'config');
}

/**
 * Host aliases from an ssh config, in the order they are declared.
 *
 * Only the names worth showing in a menu come back. A `Host` line can carry
 * several names and can carry patterns, and the two are not the same thing: a
 * pattern says which hosts a block applies to, and there is no host behind it
 * to connect to. `Host *` sets defaults for everything; `Host i-*` covers a
 * fleet whose members are not named here. Offering either as something to click
 * would produce a connection to a literal `*`.
 *
 * Reading is injected so the parsing can be tested without a filesystem, and so
 * `Include` can be followed by the same means as the outer file.
 */
export function collectSshHosts(readFile: (path: string) => string | undefined, path: string, home = homedir()): string[] {
	const hosts: string[] = [];
	const seen = new Set<string>();
	// A config that includes itself, directly or through a ring of files, would
	// otherwise read forever.
	const visited = new Set<string>();

	const visit = (current: string): void => {
		if (visited.has(current)) {
			return;
		}
		visited.add(current);

		const text = readFile(current);
		if (text === undefined) {
			return;
		}

		for (const line of text.split(/\r?\n/)) {
			// ssh accepts `Keyword value` and `Keyword=value`, and is not
			// case sensitive about the keyword.
			const match = /^\s*(?<keyword>[A-Za-z]+)[\s=]+(?<value>.*?)\s*$/.exec(line);
			if (!match?.groups) {
				continue;
			}

			const keyword = match.groups.keyword.toLowerCase();
			if (keyword === 'include') {
				for (const target of match.groups.value.split(/\s+/)) {
					const resolved = resolveInclude(target, home);
					if (resolved) {
						visit(resolved);
					}
				}
				continue;
			}

			if (keyword !== 'host') {
				continue;
			}

			for (const name of match.groups.value.split(/\s+/)) {
				if (!name || isPattern(name) || seen.has(name)) {
					continue;
				}
				seen.add(name);
				hosts.push(name);
			}
		}
	};

	visit(path);
	return hosts;
}

/** Reads the file, treating "cannot read" and "is not there" alike. */
export function readSshConfig(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * A relative `Include` is resolved against `~/.ssh`, which is what ssh does.
 *
 * Globs are left alone. Expanding one means listing a directory, and the point
 * of taking a reader as an argument is that this function does not touch the
 * filesystem. A config built out of `Include conf.d/*` will come back short
 * rather than wrong, and the hosts it names can still be reached by hand.
 */
function resolveInclude(target: string, home: string): string | undefined {
	if (isPattern(target)) {
		return undefined;
	}

	if (target.startsWith('~/')) {
		return join(home, target.slice(2));
	}

	return isAbsolute(target) ? target : join(home, '.ssh', target);
}

function isPattern(name: string): boolean {
	return name.startsWith('!') || name.includes('*') || name.includes('?');
}
