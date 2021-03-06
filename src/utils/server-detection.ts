import {
  concat, cond, equals, identity, last, pipe, T,
} from "ramda"

const isTestingEnv = process.env.NODE_ENV === "test"
const isDevelopmentEnv = process.env.NODE_ENV === "development"

// this part needs to be static and should run immediately because otherwise document.currentScript
// will be null
const currentScript = isTestingEnv
  ? { src: "http://localhost:3000/some-script.js" } // test env doesnt have document.currentScript
  : document.currentScript

const getScriptSource = () => {
  // logic based on old dashboard

  // http://stackoverflow.com/questions/984510/what-is-my-script-src-url
  // http://stackoverflow.com/questions/6941533/get-protocol-domain-and-port-from-url
  const script = cond([
    [Boolean, identity],
    // "last" typings don't work well with HTMLScriptElement
    // if document.currentScript is not available
    [T, () => last(document.getElementsByTagName("script") as unknown as [HTMLScriptElement])],
  ])(currentScript)

  return script.src
}

export const getPathFromScriptSource = (source: string) => {
  // match strings not containing slash, ending with `.js`, with optional suffix started by `?`
  const jsFilenameRegex = "[^\\/]*\\.js(\\/?.*)?$"
  const staticJsPath = "/static/js"
  return source.replace(new RegExp(jsFilenameRegex), "")
    .replace(staticJsPath, "")
}

const getDefaultServer = () => {
  if (isDevelopmentEnv) {
    return "http://localhost:19999/"
  }
  const source = getScriptSource()
  return getPathFromScriptSource(source)
}

// append "/" at the end, if it's not already there
export const alwaysEndWithSlash = cond([
  [pipe(last, equals("/")), identity],
  [T, (x: string) => concat(x, "/")], // R.__ typings don't work well
])

export const serverDefault: string = alwaysEndWithSlash(
  window.netdataServer || getDefaultServer(),
)

export const serverStatic: string = alwaysEndWithSlash(getDefaultServer())
