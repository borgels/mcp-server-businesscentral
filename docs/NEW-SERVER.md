# New server checklist

Steps for turning a repository generated from the MCP server template into a published server. `<name>` is the lowercase server name, `<PREFIX>` the environment variable prefix, `<owner>/<repo>` the GitHub repository and `<package>` the npm package name.

## 1. Rename the placeholder

Run once, right after creating the repository:

```bash
node scripts/rename.mjs <name> [<PREFIX>]
npm ci && npm run typecheck && npm test && npm run build
```

The script has no dependencies. It checks every target path first, then renames the placeholder in all files and paths, sets the npm package name in the README commands to `mcp-server-<name>`, removes the template-only README block and CI job, and deletes itself. Nothing is published (GHCR image, npm, MCP Registry) while `scripts/rename.mjs` exists or the package is still named after the placeholder, so pushes before the rename are safe.

Check that `mcp-server-<name>` is free on npm (`npm view mcp-server-<name>` should report 404). Otherwise choose another package name and change it everywhere it appears: `name` and the `bin` key in `package.json`, `package-lock.json` (run `npm install` to update it), `server.json` (`packages[].identifier`), `src/version.ts` (User-Agent) and the README commands.

## 2. Metadata the script cannot know

- `package.json`: `description`, `keywords`, `author`, `repository`, `bugs` and `homepage` URLs.
- `package.json` `overrides`: inherited from the template to keep `npm audit` clean; remove entries that are no longer needed (`npm ls <dep>`, then `npm audit --omit=dev`).
- `server.json`: `title`, `description` (at most 100 characters; CI validates it), `repository`, `environmentVariables`. `name` and `package.json` `mcpName` must be `io.github.<owner>/<repo>`, where `<owner>` is the GitHub owner of the repository (the MCP Registry grants that namespace).
- README: the vendor name in the disclaimer, the owner in clone URLs and in `ghcr.io/<owner>/...` image names, the tool table.
- `LICENSE`: the copyright line in the appendix, if you use it.
- `.github/CODEOWNERS`, `glama.json` (maintainers), `SECURITY.md` (contact).

## 3. Implement the upstream API

- `src/<name>/client.ts`: `API_KEY_HEADER` (error text redaction follows it), `UPSTREAM_HOST_SUFFIXES` to pin the hosts the key may be sent to, and a default base URL if the vendor has one fixed host.
- `src/errors.ts`: the vendor's error model and status or error-code hints; key names in `SECRET_PATTERNS`.
- API calls next to `src/<name>/items.ts`; pass every caller-supplied path segment through `encodePathParam`.
- Tools in the table in `src/tools/<name>.ts`: strict zod input, correct annotations. Read-only tools receive a client that refuses non-GET requests; give POST-based searches a dedicated method instead of the full client.
- Audit fields in `src/<name>/audit.ts`: ids in clear text, free text hashed, payloads by field name only.
- Policy in `src/<name>/policy.ts`: instance allowlists, if any.
- Tests, README tool and configuration tables, `.env.example` and `server.json` `environmentVariables` alongside.

## 4. Container image

The first push to `main` after the rename publishes `ghcr.io/<owner>/<repo>`. A new GHCR package is private: make it public in the package settings if users should pull it, and link it to the repository if GitHub did not.

## 5. First npm release (bootstrap)

npm cannot configure a trusted publisher for a package that does not exist yet.

1. Set the version (`package.json`, `server.json` twice, `src/version.ts`; tests and CI check that they agree) and `CHANGELOG.md`, and merge.
2. Publish that version by hand from a clean checkout of the merged commit: `npm login`, `npm ci`, `npm publish --access public`. Make the repository public before releases from the workflow if the package should carry npm provenance (npm only attaches it for public repositories).
3. Tag the same commit and push the tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). `release.yml` sees the version on npm, skips npm, and publishes `server.json` to the MCP Registry; `publish.yml` pushes the `vX.Y.Z` image.
4. Shortly before the next release, configure trusted publishing (npm 11.15 or later, account 2FA):

   ```bash
   npm trust github <package> --file release.yml --repository <owner>/<repo> --allow-publish
   ```

   A new configuration expires unless it completes a publish within two days.

## 6. Later releases

See "Releasing" in the README: bump the version, update the changelog, merge, push a `vX.Y.Z` tag.

## 7. Listings

Once the repository is public, claim the server on glama.ai (`glama.json` lists the maintainers). The MCP Registry entry is created by the first tagged release.
