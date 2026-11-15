// Decide which OpenWrt Snapshot targets need new AmneziaWG packages.
//
// A Snapshot kmod is tied to the kernel ABI, not to the revision: apk pins it
// with "kernel=<version>~<vermagic>-r<release>". So the key for a build is
// target/subtarget + <version>-<release>-<vermagic>. A new snapshot revision
// that leaves the kernel ABI alone produces nothing to build.
//
// Platforms: snapshot-targets.txt, or the targets/subtargets given on the
// command line (then every matching snapshot platform).
//
// Output (job-config): only the targets whose current ABI has no complete
// package set in the snapshot-linux-<version> release yet.

const axios = require('axios');
const cheerio = require('cheerio');
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');

const snapshotRoot = 'https://downloads.openwrt.org/snapshots/targets/';
const tagPrefix = 'snapshot-linux-';
const packages = [
  'kmod-amneziawg',
  'amneziawg-tools',
  'luci-proto-amneziawg',
  'luci-i18n-amneziawg-ru',
];
const excludedBuilds = [
  {
    target: 'microchipsw',
    subtarget: 'lan969x',
    reason: 'Snapshot SDK fails while packaging kmod-crypto-xxhash because xxhash.ko is built into the kernel',
  },
];

const filterTargets = parseList(process.argv[2]);
const filterSubtargets = parseList(process.argv[3]);
const force = process.argv[4] === 'true';

function parseList(value = '') {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

async function fetchText(url) {
  const { data } = await axios.get(url, { responseType: 'text', timeout: 60000 });
  return data;
}

async function directoryNames(url) {
  const $ = cheerio.load(await fetchText(url));
  const names = [];
  $('table tr td.n a').each((_, element) => {
    const href = $(element).attr('href');
    if (href && !href.startsWith('/') && href !== '../' && href.endsWith('/')) {
      names.push(href.slice(0, -1));
    }
  });
  return names;
}

async function getBuildDetails(target, subtarget) {
  const baseUrl = `${snapshotRoot}${target}/${subtarget}/`;

  // profiles.json is the metadata of the build currently on the server: it
  // names the kernel ABI directly, unlike the kmods/ listing which keeps
  // every ABI the buildbot ever produced.
  const { data: profiles } = await axios.get(`${baseUrl}profiles.json`, {
    responseType: 'json',
    timeout: 60000,
  });
  const kernel = profiles.linux_kernel || {};
  if (!kernel.version || !kernel.release || !kernel.vermagic) {
    throw new Error('profiles.json has no linux_kernel');
  }
  const pkgarch = profiles.arch_packages;
  if (!pkgarch) {
    throw new Error('profiles.json has no arch_packages');
  }

  const sums = await fetchText(`${baseUrl}sha256sums`);
  const sdkLine = sums
    .split('\n')
    .map(line => line.match(/^([0-9a-f]{64}) \*?(openwrt-sdk-.*\.Linux-x86_64\.tar\.(?:xz|zst))$/))
    .find(Boolean);
  if (!sdkLine) {
    throw new Error('no SDK in sha256sums');
  }

  const abi = `${kernel.version}-${kernel.release}-${kernel.vermagic}`;
  return {
    target,
    subtarget,
    pkgarch,
    revision: profiles.version_code || '',
    kernelVersion: kernel.version,
    vermagic: kernel.vermagic,
    abi,
    sdkFile: sdkLine[2],
    sdkSha256: sdkLine[1],
    sdkUrl: `${baseUrl}${sdkLine[2]}`,
    releaseTag: `${tagPrefix}${kernel.version}`,
    artifactPostfix: `${abi}_${pkgarch}_${target}_${subtarget}`,
  };
}

async function publishedAssets() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const names = new Set();
  if (!repo || !token) {
    core.warning('GITHUB_REPOSITORY/GITHUB_TOKEN not set, assuming nothing is published');
    return names;
  }

  const api = axios.create({
    baseURL: `https://api.github.com/repos/${repo}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    timeout: 60000,
  });

  for (let page = 1; ; page++) {
    const { data: releases } = await api.get('/releases', { params: { per_page: 100, page } });
    for (const release of releases) {
      if (!release.tag_name.startsWith(tagPrefix)) continue;
      for (let assetPage = 1; ; assetPage++) {
        const { data: assets } = await api.get(`/releases/${release.id}/assets`, {
          params: { per_page: 100, page: assetPage },
        });
        for (const asset of assets) names.add(`${release.tag_name}/${asset.name}`);
        if (assets.length < 100) break;
      }
    }
    if (releases.length < 100) break;
  }
  return names;
}

async function main() {
  if ((filterTargets.length === 0) !== (filterSubtargets.length === 0)) {
    throw new Error('Targets and subtargets must either both be set or both be empty');
  }

  const pairs = [];
  if (filterTargets.length === 0) {
    // Default: the curated list, not every snapshot platform.
    for (const line of fs.readFileSync(path.join(__dirname, 'snapshot-targets.txt'), 'utf8').split('\n')) {
      const entry = line.replace(/#.*/, '').trim();
      if (!entry) continue;
      const [target, subtarget] = entry.split('/');
      if (!target || !subtarget) throw new Error(`Bad line in snapshot-targets.txt: ${line}`);
      pairs.push([target, subtarget]);
    }
  }
  const targets = filterTargets;
  await Promise.all(targets.map(async target => {
    let subtargets;
    try {
      subtargets = await directoryNames(`${snapshotRoot}${target}/`);
    } catch (error) {
      core.warning(`Skipping target ${target}: ${error.message}`);
      return;
    }
    for (const subtarget of subtargets) {
      if (filterSubtargets.length > 0 && !filterSubtargets.includes(subtarget)) continue;
      const excluded = excludedBuilds.find(b => b.target === target && b.subtarget === subtarget);
      if (excluded) {
        core.warning(`Skipping ${target}/${subtarget}: ${excluded.reason}`);
        continue;
      }
      pairs.push([target, subtarget]);
    }
  }));

  const details = [];
  await Promise.all(pairs.map(async ([target, subtarget]) => {
    try {
      details.push(await getBuildDetails(target, subtarget));
    } catch (error) {
      core.warning(`Skipping ${target}/${subtarget}: ${error.message}`);
    }
  }));
  if (details.length === 0) {
    throw new Error('No matching Snapshot target/subtarget pairs found');
  }
  details.sort((a, b) => `${a.target}/${a.subtarget}`.localeCompare(`${b.target}/${b.subtarget}`));

  const published = await publishedAssets();
  const todo = details.filter(build => force || !packages.every(name =>
    published.has(`${build.releaseTag}/${name}_${build.artifactPostfix}.apk`)
  ));

  const lines = details.map(build => {
    const state = todo.includes(build) ? 'BUILD' : 'up to date';
    return `| ${build.target}/${build.subtarget} | ${build.abi} | ${build.revision} | ${state} |`;
  });
  await core.summary
    .addRaw(`${todo.length} of ${details.length} targets need a build${force ? ' (forced)' : ''}.\n\n`)
    .addRaw('| target | kernel ABI | revision | state |\n|---|---|---|---|\n')
    .addRaw(lines.join('\n') + '\n')
    .write()
    .catch(() => {});

  console.log(`${todo.length} of ${details.length} targets need a build`);
  for (const build of todo) console.log(`  ${build.target}/${build.subtarget} ${build.abi}`);

  core.setOutput('job-config', JSON.stringify(todo));
  core.setOutput('count', String(todo.length));
}

main().catch(error => core.setFailed(error.message));
