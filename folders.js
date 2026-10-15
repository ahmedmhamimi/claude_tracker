/**
 * Folder tree operations (pure). A folder is {id, name, parentId|null}; a
 * chat belongs to at most one folder (stored on the chat as folderId).
 * Every operation returns a NEW array and never mutates its input.
 * Deleting a folder never deletes chats: its sub-folders move up to its
 * parent and its chats are re-filed into that parent (or become unfiled at
 * the root).
 *
 * - CTS_Folders.create(list, {id, name, parentId}) -> {list, error?}
 * - CTS_Folders.rename(list, id, name) -> {list, error?}
 * - CTS_Folders.move(list, id, newParentId) -> {list, error?}: rejects cycles and unknown parents
 * - CTS_Folders.remove(list, id, chatFolders) -> {list, chatFolders}: chatFolders is {chatId: folderId}
 * - CTS_Folders.descendants(list, id) -> Set<string>: id plus every nested folder id
 * - CTS_Folders.tree(list) -> node[]: [{id, name, parentId, depth, children}] sorted by name
 * - CTS_Folders.path(list, id) -> string[]: names from the root down
 * - CTS_Folders.flatten(list) -> [{id, name, depth, path}]: for the keyboard-accessible "Move to..." menu
 */

(function (root) {
  'use strict';

  const clean = n => String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 80);
  const byId = list => new Map(list.map(f => [f.id, f]));

  function siblingsHaveName(list, parentId, name, exceptId) {
    const n = name.toLowerCase();
    return list.some(f => f.id !== exceptId && (f.parentId || null) === (parentId || null) && f.name.toLowerCase() === n);
  }

  function create(list, f) {
    const name = clean(f.name);
    if (!name) return { list, error: 'empty-name' };
    if (!f.id || list.some(x => x.id === f.id)) return { list, error: 'bad-id' };
    const parentId = f.parentId || null;
    if (parentId && !list.some(x => x.id === parentId)) return { list, error: 'no-parent' };
    if (siblingsHaveName(list, parentId, name)) return { list, error: 'duplicate-name' };
    return { list: list.concat([{ id: f.id, name, parentId }]) };
  }

  function rename(list, id, name) {
    const f = list.find(x => x.id === id);
    name = clean(name);
    if (!f) return { list, error: 'not-found' };
    if (!name) return { list, error: 'empty-name' };
    if (siblingsHaveName(list, f.parentId, name, id)) return { list, error: 'duplicate-name' };
    return { list: list.map(x => (x.id === id ? Object.assign({}, x, { name }) : x)) };
  }

  function descendants(list, id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of list) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  }

  function move(list, id, newParentId) {
    const f = list.find(x => x.id === id);
    newParentId = newParentId || null;
    if (!f) return { list, error: 'not-found' };
    if (newParentId && !list.some(x => x.id === newParentId)) return { list, error: 'no-parent' };
    if (newParentId && descendants(list, id).has(newParentId)) return { list, error: 'cycle' };
    if (siblingsHaveName(list, newParentId, f.name, id)) return { list, error: 'duplicate-name' };
    return { list: list.map(x => (x.id === id ? Object.assign({}, x, { parentId: newParentId }) : x)) };
  }

  function remove(list, id, chatFolders) {
    const f = list.find(x => x.id === id);
    if (!f) return { list, chatFolders: Object.assign({}, chatFolders) };
    const up = f.parentId || null;
    const next = list.filter(x => x.id !== id).map(x => (x.parentId === id ? Object.assign({}, x, { parentId: up }) : x));
    const cf = {};
    Object.keys(chatFolders || {}).forEach(c => { cf[c] = chatFolders[c] === id ? up : chatFolders[c]; if (cf[c] === null) delete cf[c]; });
    return { list: next, chatFolders: cf };
  }

  function tree(list) {
    const kids = new Map();
    list.forEach(f => { const k = f.parentId || null; (kids.get(k) || kids.set(k, []).get(k)).push(f); });
    const build = (parent, depth, seen) => (kids.get(parent) || [])
      .slice().sort((a, b) => a.name.localeCompare(b.name))
      .filter(f => !seen.has(f.id))
      .map(f => { const s = new Set(seen); s.add(f.id); return { id: f.id, name: f.name, parentId: f.parentId || null, depth, children: build(f.id, depth + 1, s) }; });
    return build(null, 0, new Set());
  }

  function path(list, id) {
    const m = byId(list), out = [], seen = new Set();
    let cur = m.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur.name); cur = cur.parentId ? m.get(cur.parentId) : null; }
    return out;
  }

  function flatten(list) {
    const out = [];
    const walk = nodes => nodes.forEach(n => { out.push({ id: n.id, name: n.name, depth: n.depth, path: path(list, n.id).join(' / ') }); walk(n.children); });
    walk(tree(list));
    return out;
  }

  const api = { create, rename, move, remove, descendants, tree, path, flatten };
  root.CTS_Folders = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
