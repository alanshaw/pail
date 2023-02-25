import { create, load } from 'prolly-trees/db-index'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { nocache as cache } from 'prolly-trees/cache'
import { bf, simpleCompare as compare } from 'prolly-trees/utils'
import * as codec from '@ipld/dag-cbor'
import { create as createBlock } from 'multiformats/block'
const opts = { cache, chunker: bf(3), codec, hasher, compare }

const ALWAYS_REBUILD = false

const makeGetBlock = (blocks) => async (address) => {
  const { cid, bytes } = await blocks.get(address)
  return createBlock({ cid, bytes, hasher, codec })
}
const makeDoc = ({ key, value }) => ({ _id: key, ...value })

/**
 * Transforms a set of changes to index entries using a map function.
 *
 * @param {Array<{ key: string, value: import('./link').AnyLink, del?: boolean }>} changes
 * @param {Function} mapFun
 * @returns {Array<{ key: [string, string], value: any }>} The index entries generated by the map function.
 */

const indexEntriesForChanges = (changes, mapFun) => {
  const indexEntries = []
  changes.forEach(({ key, value, del }) => {
    if (del) return
    mapFun(makeDoc({ key, value }), (k, v) => {
      indexEntries.push({
        key: [k, key],
        value: v
      })
    })
  })
  return indexEntries
}

// const OLDindexEntriesForOldChanges = (docs, mapFun) => {
//   const indexEntries = []
//   docs.forEach((doc) => {
//     mapFun(doc, (k) => {
//       indexEntries.push({
//         key: [k, doc._id],
//         del: true
//       })
//     })
//   })
//   return indexEntries
// }

const oldDocsBeforeChanges = async (changes, snapshot) => {
  const oldDocs = new Map()
  for (const { key } of changes) {
    if (oldDocs.has(key)) continue
    try {
      const change = await snapshot.get(key)
      oldDocs.set(key, change)
    } catch (e) {
      console.log('olddocs e', key, e.message)
      if (e.message !== 'Not found') throw e
    }
  }
  return Array.from(oldDocs.values())
}

const indexEntriesForOldChanges = async (blocks, byIDindexRoot, ids, mapFun) => {
  const getBlock = makeGetBlock(blocks)
  const byIDindex = await load({ cid: byIDindexRoot.cid, get: getBlock, ...opts })
  // console.trace('ids', ids)
  const result = await byIDindex.getMany(ids)
  console.log('indexEntriesForOldChanges', result.result)
  return result.result
}

/**
 * Represents an index for a Fireproof database.
 *
 * @class
 * @classdesc An index can be used to order and filter the documents in a Fireproof database.
 *
 * @param {import('./fireproof').Fireproof} database - The Fireproof database instance to index.
 * @param {Function} mapFun - The map function to apply to each entry in the database.
 *
 */
export default class Index {
  /**
   * Creates a new index with the given map function and database.
   * @param {import('./fireproof').Fireproof} database - The Fireproof database instance to index.
   * @param {Function} mapFun - The map function to apply to each entry in the database.
   */
  constructor (database, mapFun) {
    /**
     * The database instance to index.
     * @type {import('./fireproof').Fireproof}
     */
    this.database = database
    /**
     * The map function to apply to each entry in the database.
     * @type {Function}
     */
    this.mapFun = mapFun
    this.indexRoot = null
    this.byIDindexRoot = null
    this.dbHead = null
  }

  /**
   * Query object can have {range}
   *
   */
  async query (query, root = null) {
    if (!root) {
      await this.#updateIndex()
    }
    root = root || this.indexRoot
    const response = await queryIndexRange(this.database.blocks, root, query)
    return {
      // TODO fix this naming upstream in prolly/db-index
      // todo maybe this is a hint about why deletes arent working?
      rows: response.result.map(({ id, key, row }) => ({ id: key, key: id, value: row }))
    }
  }

  /**
   * Update the index with the latest changes
   * @private
   * @returns {Promise<void>}
   */
  async #updateIndex () {
    // todo remove this hack
    if (ALWAYS_REBUILD) {
      this.dbHead = null // hack
      this.indexRoot = null // hack
    }
    const result = await this.database.changesSince(this.dbHead) // {key, value, del}
    if (this.dbHead) {
      const oldIndexEntries = (await indexEntriesForOldChanges(this.database.blocks, this.byIDindexRoot, result.rows.map(({ key }) => key), this.mapFun))
        // .map((key) => ({ key, value: null })) // tombstone just adds more rows...
        // .map((key) => ({ key, del: true })) // should be this
        .map((key) => ({ key: undefined, del: true })) // todo why does this work?

      this.indexRoot = await bulkIndex(this.database.blocks, this.indexRoot, oldIndexEntries, opts)
      console.log('oldIndexEntries', oldIndexEntries)
      // [ { key: ['b', 1], del: true } ]
      // [ { key: [ 5, 'x' ], del: true } ]
      // for now we just let the by id index grow and then don't use the results...
      // const removeByIdIndexEntries = oldIndexEntries.map(({ key }) => ({ key: key[1], del: true }))
      // this.byIDindexRoot = await bulkIndex(this.database.blocks, this.byIDindexRoot, removeByIdIndexEntries, opts)
    }
    const indexEntries = indexEntriesForChanges(result.rows, this.mapFun)
    const byIdIndexEntries = indexEntries.map(({ key, value }) => ({ key: key[1], value: key }))
    // [{key:  'xxxx-3c3a-4b5e-9c1c-8c5c0c5c0c5c', value : [ 53, 'xxxx-3c3a-4b5e-9c1c-8c5c0c5c0c5c' ]}]
    this.byIDindexRoot = await bulkIndex(this.database.blocks, this.byIDindexRoot, byIdIndexEntries, opts)
    this.indexRoot = await bulkIndex(this.database.blocks, this.indexRoot, indexEntries, opts)
    this.dbHead = result.head
  }

  // todo use the index from other peers?
  // we might need to add CRDT logic to it for that
  // it would only be a performance improvement, but might add a lot of complexity
  //   advanceIndex ()) {}
}

/**
 * Update the index with the given entries
 * @param {Blockstore} blocks
 * @param {import('multiformats/block').Block} inRoot
 * @param {import('prolly-trees/db-index').IndexEntry[]} indexEntries
 */
async function bulkIndex (blocks, inRoot, indexEntries) {
  if (!indexEntries.length) return inRoot
  const putBlock = blocks.put.bind(blocks)
  const getBlock = makeGetBlock(blocks)
  if (!inRoot) {
    // make a new index

    for await (const node of await create({ get: getBlock, list: indexEntries, ...opts })) {
      const block = await node.block
      await putBlock(block.cid, block.bytes)
      inRoot = block
    }
    console.log('created index', inRoot.cid)
    return inRoot
  } else {
    // load existing index
    console.log('loading index', inRoot.cid)
    const index = await load({ cid: inRoot.cid, get: getBlock, ...opts })
    console.log('new indexEntries', indexEntries)
    const { root, blocks } = await index.bulk(indexEntries)
    for await (const block of blocks) {
      await putBlock(block.cid, block.bytes)
    }
    console.log('updated index', root.block.cid)

    return root.block // if we hold the root we won't have to load every time
  }
}

/**
 * Query the index for the given range
 * @param {Blockstore} blocks
 * @param {import('multiformats/block').Block} inRoot
 * @param {import('prolly-trees/db-index').Query} query
 * @returns {Promise<import('prolly-trees/db-index').QueryResult>}
 **/
async function queryIndexRange (blocks, { cid }, query) {
  if (!cid) return { result: [] }
  const getBlock = makeGetBlock(blocks)
  const index = await load({ cid, get: getBlock, ...opts })
  return index.range(...query.range)
}
