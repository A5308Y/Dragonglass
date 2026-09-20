module Gtd.Id exposing (ActionId, InboxItemId, ProjectId)

{-| The stable ULIDs that define identity across the vault.

These are aliases rather than opaque types on purpose: ids are used as `Dict` and
`Set` keys throughout the views, and those containers require a `comparable`. The
aliases still name the intent at every signature that carries one.

-}


type alias ActionId =
    String


type alias ProjectId =
    String


type alias InboxItemId =
    String
