// The renderer sources import local files without extensions (bundler style); add .ts/.tsx when Node cannot find them.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          return await next(specifier + ext, context)
        } catch {}
      }
    }
    throw e
  }
}
