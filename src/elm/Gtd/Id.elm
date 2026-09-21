module Gtd.Id exposing (ActionId, FeedId, FeedItemKey, InboxItemId, ProjectId)

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


type alias FeedId =
    String


{-| A Feed Item's identity within its feed: its guid, id, link, or a digest.

Feed Items are not vault entities and carry no ULID, so a key is only unique
alongside the feed that produced it.

-}
type alias FeedItemKey =
    String
