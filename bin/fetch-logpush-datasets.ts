#!/usr/bin/env tsx

import fs from "fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "path";
import YAML from "yaml";

import {
	downloadToDotTempIfNotPresent,
	extractTarGz,
	getDotTmpPath,
} from "../src/util/custom-loaders";

const MIDDLECACHE_BASE_URL =
	process.env.MIDDLECACHE_BASE_URL ?? "https://middlecache.ced.cloudflare.com/";
const ARCHIVE_MIDDLECACHE_PATH = "v1/logpush-datasets/datasets.tar.gz";
const ARCHIVE_DOT_TMP_PATH = `middlecache/${ARCHIVE_MIDDLECACHE_PATH}`;
const DOT_TMP_DIR = getDotTmpPath();
const REPO_ROOT = dirname(DOT_TMP_DIR);
const DATASETS_DIR = resolve(
	process.env.LOGPUSH_DATASETS_DIR ??
		join(REPO_ROOT, "src/content/docs/logs/logpush/logpush-job/datasets"),
);
const EXTRACTED_DIR = join(DOT_TMP_DIR, "logpush-datasets");
const syncKey = createHash("sha256")
	.update(DATASETS_DIR)
	.digest("hex")
	.slice(0, 12);
const SYNC_STATE_PATH = join(DOT_TMP_DIR, `logpush-datasets-${syncKey}.state`);
const PENDING_STATE_PATH = `${SYNC_STATE_PATH}.pending`;
const STAGING_DIR = join(
	dirname(DATASETS_DIR),
	`.${basename(DATASETS_DIR)}.sync-staging`,
);
const BACKUP_DIR = join(
	dirname(DATASETS_DIR),
	`.${basename(DATASETS_DIR)}.sync-backup`,
);

// Soft mode preserves checked-in pages when fresh data is unavailable.
const soft = process.argv.includes("--soft");
const force = process.argv.includes("--force");

const fail = (message: string): never => {
	if (soft) {
		console.warn(
			`Warning: ${message} - continuing with checked-in Logpush dataset pages`,
		);
		process.exit(0);
	}
	console.error(`Error: ${message}`);
	process.exit(1);
};

const validatePage = (page: string) => {
	const content = fs.readFileSync(join(EXTRACTED_DIR, page), "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
		content,
	)?.[1];
	const metadata = frontmatter
		? (YAML.parse(frontmatter) as unknown)
		: undefined;
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("title" in metadata) ||
		typeof metadata.title !== "string" ||
		metadata.title.trim() === ""
	) {
		throw new Error(`Logpush dataset page has invalid frontmatter: ${page}`);
	}
};

const directoryDigest = (directory: string) => {
	const hash = createHash("sha256");
	const files = fs
		.globSync("**/*", { cwd: directory })
		.filter((file) => fs.statSync(join(directory, file)).isFile())
		.sort();
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(fs.readFileSync(join(directory, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
};

const directoriesEqual = (left: string, right: string) =>
	directoryDigest(left) === directoryDigest(right);

const directoryMatchesState = (directory: string, statePath: string) =>
	fs.existsSync(statePath) &&
	directoryDigest(directory) === fs.readFileSync(statePath, "utf8");

const writeState = (statePath: string, digest: string) => {
	const temporaryPath = `${statePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, digest);
	fs.renameSync(temporaryPath, statePath);
};

const promotePendingState = () => {
	writeState(SYNC_STATE_PATH, fs.readFileSync(PENDING_STATE_PATH, "utf8"));
	fs.rmSync(PENDING_STATE_PATH, { force: true });
};

const promotePendingStateOrDefer = () => {
	try {
		promotePendingState();
	} catch (err) {
		console.warn(
			`Warning: deferring Logpush dataset state update: ${(err as Error).message}`,
		);
	}
};

const ensureDatasetsUnmodified = () => {
	const status = spawnSync(
		"git",
		[
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			relative(REPO_ROOT, DATASETS_DIR),
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (status.error) {
		throw status.error;
	}
	if (status.status !== 0) {
		throw new Error(`git status failed: ${status.stderr.trim()}`);
	}
	if (
		status.stdout.trim() &&
		!directoryMatchesState(DATASETS_DIR, SYNC_STATE_PATH)
	) {
		throw new Error("Logpush dataset directory has uncommitted changes");
	}
};

const archivePath = join(DOT_TMP_DIR, ...ARCHIVE_DOT_TMP_PATH.split("/"));
console.log("Fetching Logpush dataset pages from middlecache");

let replacementStarted = false;
try {
	if (!fs.existsSync(DATASETS_DIR) && fs.existsSync(BACKUP_DIR)) {
		fs.renameSync(BACKUP_DIR, DATASETS_DIR);
	}
	if (
		!fs.existsSync(DATASETS_DIR) ||
		!fs.statSync(DATASETS_DIR).isDirectory()
	) {
		throw new Error(
			`Logpush dataset directory does not exist: ${DATASETS_DIR}`,
		);
	}
	if (fs.existsSync(PENDING_STATE_PATH)) {
		if (directoryMatchesState(DATASETS_DIR, PENDING_STATE_PATH)) {
			promotePendingState();
		} else {
			if (fs.existsSync(BACKUP_DIR)) {
				ensureDatasetsUnmodified();
			}
			fs.rmSync(PENDING_STATE_PATH, { force: true });
		}
	}
	fs.rmSync(STAGING_DIR, { recursive: true, force: true });
	if (fs.existsSync(BACKUP_DIR)) {
		console.warn(
			`Warning: removing stale Logpush dataset backup: ${BACKUP_DIR}`,
		);
		fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
	}
	if (force) {
		fs.rmSync(archivePath, { force: true });
	}

	await downloadToDotTempIfNotPresent(
		`${MIDDLECACHE_BASE_URL}${ARCHIVE_MIDDLECACHE_PATH}`,
		ARCHIVE_DOT_TMP_PATH,
	);

	fs.rmSync(EXTRACTED_DIR, { recursive: true, force: true });
	await extractTarGz(archivePath, EXTRACTED_DIR);

	const destinationPages = fs.globSync("*/*.md", { cwd: DATASETS_DIR });
	if (destinationPages.length === 0) {
		throw new Error("Logpush dataset directory contains no managed pages");
	}
	const destinationScopes = new Set(
		destinationPages.map((page) => dirname(page)),
	);
	// The archive contains <scope>/<page>.md; only sync existing docs scopes.
	const pagesToCopy = fs
		.globSync("*/*.md", { cwd: EXTRACTED_DIR })
		.filter((page) => destinationScopes.has(dirname(page)));
	for (const page of pagesToCopy) {
		validatePage(page);
	}
	const sourcePages = new Set(pagesToCopy);
	// Destination pages missing from the filtered archive are stale.
	const pagesToRemove = destinationPages.filter(
		(page) => !sourcePages.has(page),
	);
	const sourceScopes = new Set(pagesToCopy.map((page) => dirname(page)));
	const missingScopes = [...destinationScopes].filter(
		(scope) => !sourceScopes.has(scope),
	);

	if (missingScopes.length > 0) {
		throw new Error(
			`Logpush dataset archive is missing scopes: ${missingScopes.join(", ")}`,
		);
	}
	const unsafeScopes = [...destinationScopes].filter((scope) => {
		const scopePageCount = destinationPages.filter(
			(page) => dirname(page) === scope,
		).length;
		const scopeRemovalCount = pagesToRemove.filter(
			(page) => dirname(page) === scope,
		).length;
		return scopeRemovalCount > scopePageCount * 0.25;
	});
	if (unsafeScopes.length > 0) {
		throw new Error(
			`Logpush dataset sync would remove more than 25% of pages in scopes: ${unsafeScopes.join(", ")}`,
		);
	}

	fs.cpSync(DATASETS_DIR, STAGING_DIR, { recursive: true });
	for (const page of pagesToCopy) {
		fs.copyFileSync(join(EXTRACTED_DIR, page), join(STAGING_DIR, page));
	}
	for (const page of pagesToRemove) {
		fs.rmSync(join(STAGING_DIR, page));
	}

	ensureDatasetsUnmodified();
	writeState(PENDING_STATE_PATH, directoryDigest(STAGING_DIR));
	if (directoriesEqual(DATASETS_DIR, STAGING_DIR)) {
		promotePendingStateOrDefer();
		fs.rmSync(STAGING_DIR, { recursive: true });
	} else {
		fs.renameSync(DATASETS_DIR, BACKUP_DIR);
		replacementStarted = true;
		try {
			fs.renameSync(STAGING_DIR, DATASETS_DIR);
		} catch (err) {
			try {
				fs.renameSync(BACKUP_DIR, DATASETS_DIR);
			} catch {
				throw new Error(
					`Logpush dataset swap failed; original pages remain at ${BACKUP_DIR}`,
					{ cause: err },
				);
			}
			throw err;
		}
		promotePendingStateOrDefer();
		try {
			fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
		} catch (err) {
			console.warn(
				`Warning: failed to remove Logpush dataset backup: ${(err as Error).message}`,
			);
		}
	}
	console.log("Logpush dataset pages ready");
} catch (err) {
	try {
		fs.rmSync(STAGING_DIR, { recursive: true, force: true });
	} catch {
		// Preserve the original error.
	}
	if (replacementStarted && !fs.existsSync(DATASETS_DIR)) {
		console.error(
			`Error: Logpush dataset replacement failed; original pages remain at ${BACKUP_DIR}`,
		);
		process.exit(1);
	}
	fail(`Logpush dataset fetch failed: ${(err as Error).message}`);
}
