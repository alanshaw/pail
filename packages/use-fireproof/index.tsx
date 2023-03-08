/* global localStorage */
import { useEffect, useState, createContext } from 'react'
import { Fireproof, Listener } from '@fireproof/core'

export const FireproofCtx = createContext<Fireproof>(null) // todo bad type

let storageSupported = false
try {
  storageSupported = window.localStorage && true
} catch (e) {}
export function localGet(key: string) {
  if (storageSupported) {
    return localStorage && localStorage.getItem(key)
  }
}
function localSet(key: string, value: string) {
  if (storageSupported) {
    return localStorage && localStorage.setItem(key, value)
  }
}
// function localRemove(key) {
//   if (storageSupported) {
//     return localStorage && localStorage.removeItem(key)
//   }
// }

const inboundSubscriberQueue = new Map()
const database = Fireproof.storage()
const listener = new Listener(database)

export function useFireproof(
  defineDatabaseFn: Function,
  setupFn: Function
): {
  addSubscriber: (label: String, fn: Function) => void
  database: Fireproof
  ready: boolean
} {
  const [ready, setReady] = useState(false)

  if (!ready) {
    defineDatabaseFn(database)
  }

  const addSubscriber = (label: String, fn: Function) => {
    inboundSubscriberQueue.set(label, fn)
  }

  const listenerCallback = async () => {
    localSet('fireproof', JSON.stringify(database))
    for (const [, fn] of inboundSubscriberQueue) fn()
  }

  useEffect(() => {
    const doSetup = async () => {
      if (ready) return
      const fp = localGet('fireproof')
      if (fp) {
        const { clock } = JSON.parse(fp)
        console.log("Loading previous database clock. (delete localStorage['fireproof'] to reset)")
        await database.setClock(clock)
        try {
          await database.changesSince()
        } catch (e) {
          console.error('Error loading previous database clock.', e)
          await database.setClock([])
          await setupFn(database)
          localSet('fireproof', JSON.stringify(database))
        }
      } else {
        await setupFn(database)
        localSet('fireproof', JSON.stringify(database))
      }
      setReady(true)
      listener.on('*', husher('*', listenerCallback, 250))
    }
    doSetup()
  }, [ready])

  return {
    addSubscriber,
    database,
    ready,
  }
}

const husherMap = new Map()
const husher = (id: string, workFn: { (): Promise<any> }, ms: number) => {
  if (!husherMap.has(id)) {
    husherMap.set(
      id,
      workFn().finally(() => setTimeout(() => husherMap.delete(id), ms))
    )
  }
  return husherMap.get(id)
}