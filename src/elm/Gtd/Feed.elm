module Gtd.Feed exposing
    ( Feed
    , Feeds
    , Item
    , Status(..)
    , Sweep
    , decoder
    , empty
    , itemsOf
    , statusText
    , sweep
    , totalUnread
    )

{-| The Feeds surface's own data.

Feed Items are not vault entities, so they travel in their own payload rather than
in the GTD snapshot: a fetch that adds two hundred rows must not read to the rest
of the plugin like two hundred Projects changing.

-}

import Gtd.Id exposing (FeedId, FeedItemKey)
import Json.Decode as Decode exposing (Decoder)
import Set exposing (Set)


type alias Item =
    { key : FeedItemKey
    , title : String
    , link : String
    , published : String
    , age : String
    , author : String
    , summary : String
    }


type alias Feed =
    { id : FeedId
    , title : String
    , url : String
    , enabled : Bool
    , fetched : String
    , error : String
    , items : List Item
    }


type Status
    = Disabled
    | Idle
    | Fetching
    | Succeeded
    | Failed


type alias Feeds =
    { enabled : Bool
    , status : Status
    , lastFetch : String
    , error : String
    , undoCount : Int
    , feeds : List Feed
    }


empty : Feeds
empty =
    { enabled = False, status = Disabled, lastFetch = "", error = "", undoCount = 0, feeds = [] }


totalUnread : Feeds -> Int
totalUnread feeds =
    feeds.feeds |> List.map (.items >> List.length) |> List.sum


itemsOf : Feeds -> List Item
itemsOf feeds =
    List.concatMap .items feeds.feeds


statusText : Feeds -> String
statusText feeds =
    case feeds.status of
        Disabled ->
            "Feeds are switched off."

        Idle ->
            "Waiting for the first fetch."

        Fetching ->
            "Fetching…"

        Succeeded ->
            if String.isEmpty feeds.lastFetch then
                "Up to date."

            else
                "Fetched " ++ feeds.lastFetch ++ "."

        Failed ->
            if String.isEmpty feeds.error then
                "The last fetch failed."

            else
                feeds.error



-- SWEEPING


{-| What one sweep button will do, and how it says so.

A sweep is the whole point of the surface: the Items marked to keep become Inbox
Items and everything else shown is discarded, in one press. The label names both
halves so nothing is thrown away by a button that only said "Discard".

-}
type alias Sweep =
    { keep : List FeedItemKey
    , discard : List FeedItemKey
    , label : String
    , ready : Bool
    }


sweep : Set FeedItemKey -> List Item -> Sweep
sweep kept items =
    let
        keys =
            List.map .key items

        ( keep, discard ) =
            List.partition (\key -> Set.member key kept) keys

        keepCount =
            List.length keep

        discardCount =
            List.length discard
    in
    { keep = keep
    , discard = discard
    , label =
        if keepCount == 0 && discardCount == 0 then
            "Nothing to sweep"

        else if keepCount == 0 then
            "Discard all (" ++ String.fromInt discardCount ++ ")"

        else if discardCount == 0 then
            "Keep all (" ++ String.fromInt keepCount ++ ")"

        else
            "Keep " ++ String.fromInt keepCount ++ ", discard " ++ String.fromInt discardCount
    , ready = keepCount + discardCount > 0
    }



-- DECODING


decoder : Decoder Feeds
decoder =
    Decode.map6 Feeds
        (field "enabled" Decode.bool False)
        (field "state" statusDecoder Disabled)
        (field "lastFetch" Decode.string "")
        (field "error" Decode.string "")
        (field "undoCount" Decode.int 0)
        (field "feeds" (Decode.list feedDecoder) [])


statusDecoder : Decoder Status
statusDecoder =
    Decode.string
        |> Decode.map
            (\raw ->
                case raw of
                    "idle" ->
                        Idle

                    "fetching" ->
                        Fetching

                    "success" ->
                        Succeeded

                    "error" ->
                        Failed

                    _ ->
                        Disabled
            )


feedDecoder : Decoder Feed
feedDecoder =
    Decode.map7 Feed
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (field "url" Decode.string "")
        (field "enabled" Decode.bool True)
        (field "fetched" Decode.string "")
        (field "error" Decode.string "")
        (field "items" (Decode.list itemDecoder) [])


itemDecoder : Decoder Item
itemDecoder =
    Decode.map7 Item
        (Decode.field "key" Decode.string)
        (Decode.field "title" Decode.string)
        (field "link" Decode.string "")
        (field "published" Decode.string "")
        (field "age" Decode.string "")
        (field "author" Decode.string "")
        (field "summary" Decode.string "")


field : String -> Decoder a -> a -> Decoder a
field name valueDecoder fallback =
    Decode.oneOf [ Decode.field name valueDecoder, Decode.succeed fallback ]
