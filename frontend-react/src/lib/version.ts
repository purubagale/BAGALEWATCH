/** Build stamp for this bundle (2026-08-23).
 *
 * Vite inlines `import.meta.env.VITE_*` at BUILD time, so these are literals
 * baked into the JS — not runtime lookups. They come from the ARGs in
 * frontend-react/Dockerfile, which build-push.sh fills from the release
 * version and the immutable `$VERSION-BUILDNO-NPTTIME-GITSHA` tag.
 *
 * `dev` is the honest default for a plain `docker compose build`, which has
 * no release version to claim. Anything showing `dev` in a real deployment
 * means the image was not built through build-push.sh.
 *
 * Deliberately separate from the backend's APP_VERSION, which is read from
 * the environment at RUNTIME and reported on /api/v2/health/. Comparing the
 * two is the point: they diverge the moment one service is redeployed
 * without the other, and the About page surfaces that.
 */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || 'dev'
export const BUILD_TAG: string = import.meta.env.VITE_BUILD_TAG || ''
export const GIT_SHA: string = import.meta.env.VITE_GIT_SHA || ''

/** True when this bundle was stamped by a real release build. */
export const IS_RELEASE_BUILD: boolean = APP_VERSION !== 'dev'
