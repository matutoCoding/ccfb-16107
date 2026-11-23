// IndexedDB 轻封装：所有布展方案与烘焙产物本地持久化，发布端只读贴图

const DB_NAME = 'virtual_hall_baker'
const DB_VERSION = 1

export const STORES = {
  halls: 'halls',
  bakes: 'bakes',
  textures: 'textures',
  ies: 'ies',
  probes: 'probes',
  publishes: 'publishes',
  snapshots: 'snapshots',
} as const

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb()
  return await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  return await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function idbKeys(store: string): Promise<string[]> {
  const db = await openDb()
  return await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).getAllKeys()
    request.onsuccess = () => resolve(request.result as string[])
    request.onerror = () => reject(request.error)
  })
}
