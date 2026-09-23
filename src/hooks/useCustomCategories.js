import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { hasColumn } from '../lib/schema'
import { setCustomCategories, resetCustomCategories } from '../lib/categories'

/**
 * Load the user's custom categories into the module store (lib/categories)
 * once a session exists, and again whenever the user changes.
 *
 * After the schema probe rather than alongside it, unlike useSchemaCheck:
 * the rows are owner-scoped, so a request before sign-in returns nothing
 * and would leave every picker on the built-in list until a reload. A
 * database behind 030 skips the request entirely.
 *
 * @param {string|undefined} userId - the signed-in user, or nothing
 * @param {boolean} ready - true once the schema probe has answered
 * @returns {number} bumps after each load, so the caller re-renders and the
 *   open page reads the merged list
 */
export function useCustomCategories(userId, ready) {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!userId || !ready) {
      resetCustomCategories()
      return undefined
    }
    if (!hasColumn('categories.name')) return undefined

    let cancelled = false
    supabase
      .from('categories')
      .select('id, name, section, icon')
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.warn('Custom categories could not be loaded:', error.message)
          return
        }
        setCustomCategories(data || [])
        setVersion((v) => v + 1)
      })

    return () => {
      cancelled = true
    }
  }, [userId, ready])

  return version
}
