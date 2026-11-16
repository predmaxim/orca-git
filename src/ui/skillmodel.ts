// The path field of a review skill or an image, as logic: what to browse for what is typed, and what to suggest. No DOM.

/** The folder to browse for what is typed: everything up to and including the last «/». */
export function browseDir(value: string): string {
  return value.slice(0, value.lastIndexOf('/') + 1)
}

/** The suggestions for what is typed: the files listed (the worker lists only `.md` files or images), then the folders (with «/»), whose names start with the typed name, any case. */
export function skillSuggestions(value: string, listing: { dirs: string[]; files: string[] }): string[] {
  const dir = browseDir(value)
  const typed = value.slice(dir.length).toLowerCase()
  const like = (name: string) => name.toLowerCase().startsWith(typed)
  return [...listing.files.filter(like).map((name) => dir + name), ...listing.dirs.filter(like).map((name) => `${dir}${name}/`)]
}
