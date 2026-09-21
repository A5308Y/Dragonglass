module Gtd.Command.Feeds exposing (Command(..), encode)

{-| Commands owned by the Feeds surface.
-}

import Gtd.Command as Base
import Gtd.Id exposing (FeedItemKey)
import Json.Encode as Encode


type Command
    = RefreshFeeds
    | AddFeed
    | KeepItems (List FeedItemKey)
    | DiscardItems (List FeedItemKey)
    | UndoDiscard
    | OpenLink String
    | OpenInbox


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            RefreshFeeds ->
                Base.RefreshFeeds

            AddFeed ->
                Base.AddFeed

            KeepItems keys ->
                Base.KeepFeedItems keys

            DiscardItems keys ->
                Base.DiscardFeedItems keys

            UndoDiscard ->
                Base.UndoFeedDiscard

            OpenLink url ->
                Base.OpenLink url

            OpenInbox ->
                Base.OpenInbox
        )
