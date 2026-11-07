---
title: A restriction value the app's own picker never offers (Root as a property class) was accepted by the API and meant two different things
area: api
tags: [classes, root, property-classes, validation, app-parity, picker, silent-success, set-block-property, hidden-property]
seen:
  - 2026-11-07 – item 26 defect 3, patch 0032 (createProperty classes and updateProperty classes.set/add accepted Root)
promoted_to: []
---

## Symptom

`create_property` and `update_property` with `classes` containing Root (`:logseq.class/Root`, "Root Tag") by title, UUID or ident answered 201/200 and stored it. In the app a Root-only restriction means "no restriction", but server writes treated it as "tagged nodes only": setting the property to a plain page worked, and setting it to an untagged block answered 400 `no #Root Tag object`.

## Cause

Patch 0026's `validate-property-classes` resolved classes with `resolve-tag-selector`, which accepts any non-hidden class, and Root is one. Nothing compared the allowed values with what the app lets a user pick. The app's property config picker loads classes with `{:except-root-class? true}`, and its value picker strips Root (`non-root-classes`) before building choices. So the app never produces this state, and the server's class checks (`class-instance?`) read it differently from the app's pickers.

## Fix

Patch 0032: `validate-property-classes` refuses Root on create, `classes.set` and `classes.add`, naming the entry (`classes.add 1: Root Tag is not a valid class restriction (it would allow any node; leave classes empty instead)`), before anything is written. `classes.remove` still takes a stored Root off so existing graphs can be cleaned up. Only Root is refused, because it is the only class the app's picker hides. Review left one gap: `setBlockProperty` on a property's hidden `logseq.property/classes` still stores Root, so that write path is unguarded.

## How to catch it next time

- When a validator accepts a set of values, read the app's picker for that field and copy its exclusions (`:except-root-class?`, `except-private-tags?`). A value the UI never offers is a value the API should usually refuse, or define.
- Test every value form (title, UUID, ident, db id) and a refusal inside a list with a valid value, and check nothing was partly written.
- Keep the `remove` path open for a bad value already stored.
- A new refusal on a property's schema must also cover the generic property-write path that can reach the same hidden attribute.
