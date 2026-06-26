# Release Checklist

This checklist is for publishing `@aionis/substrate`.

## Preconditions

- Node 24 or newer is installed.
- `npm ci` has completed.
- `package.json` version, `package-lock.json` version, and `CHANGELOG.md` agree.
- `LICENSE` is present and `package.json` has the matching SPDX license.
- The working tree is clean except for intentional release changes.

## Local Gate

Run the full release gate:

```bash
npm run check:release
```

Run the scale smoke:

```bash
npm run check:scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000
```

Run the basic package example:

```bash
npm run example:basic
```

## Package Inspection

Dry-run the package contents:

```bash
npm pack --dry-run
```

The package should contain runtime artifacts, docs, examples, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`. It must not contain `src/`, `test/`, `scripts/`, `.github/`, `reports/`, or `node_modules/`.

## Publish

For a public npm release:

```bash
npm publish --access public
```

After publish, install the package in a fresh project and run the basic store operations from `examples/basic`.

## Git

Create a release commit and tag:

```bash
git tag v0.1.0
git push origin main --tags
```
