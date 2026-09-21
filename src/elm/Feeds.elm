port module Feeds exposing (main)

{-| Triage for subscribed feeds.

This is the list the Inbox deliberately is not. Processing an Inbox Item is one
decision at a time against a two-minute budget, because every capture there was
put there on purpose. A feed sends far more than it is owed, so almost every Item
earns one verdict — gone — and only a few are worth clarifying.

So the list is the surface rather than a way into a processor. **Keep** acts on
one Item immediately, sending it to the Inbox to be clarified there later; there
is no intermediate "marked" state to sweep afterward. Discarding is coarser on
purpose — a whole feed's remaining Items, or every open feed's, in one press —
because that is the actual shape of feed triage: a couple of Items are worth
keeping and the rest is noise. Nothing here is a vault file until it is kept,
which is why discarding two hundred rows is one write and can be undone.

-}

import Browser
import Browser.Dom
import Dict exposing (Dict)
import Gtd.Command.Feeds as Command exposing (Command)
import Gtd.Feed as Feed exposing (Feed, Feeds, Item)
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (FeedId, FeedItemKey)
import Gtd.Ui as Ui exposing (Key(..))
import Html exposing (Html, article, button, div, h2, h3, header, input, p, section, small, span, text)
import Html.Attributes exposing (attribute, autofocus, class, classList, disabled, id, placeholder, tabindex, title, type_, value)
import Html.Events exposing (onBlur, onClick, onFocus, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Task


port feedsToHost : Encode.Value -> Cmd msg


port feedsFromHost : (Decode.Value -> msg) -> Sub msg


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | Working


type alias Model =
    { feeds : Feeds
    , search : String
    , collapsed : Set FeedId
    , expanded : Set FeedItemKey
    , focusIndex : Maybe Int
    , renaming : Maybe { feedId : FeedId, title : String }
    , requests : Requests Pending
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleCollapsed FeedId
    | ToggleExpanded FeedItemKey
    | SetFocus Int
    | RowKey Int FeedItemKey Key
    | CollapseAll Bool
    | KeepOne FeedItemKey
    | DiscardSection FeedId
    | DiscardAll
    | Open String
    | StartRename FeedId String
    | RenameChanged String
    | SaveRename
    | CancelRename
    | Send Pending Command
    | Focused (Result Browser.Dom.Error ())
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = always (feedsFromHost GotHost)
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue (Decode.field "feeds" Feed.decoder) flags of
        Ok feeds ->
            ( initialModel feeds, Cmd.none )

        Err error ->
            ( { blank | error = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Feeds -> Model
initialModel feeds =
    { feeds = feeds
    , search = ""
    , collapsed = Set.empty
    , expanded = Set.empty
    , focusIndex = Nothing
    , renaming = Nothing
    , requests = Host.noRequests
    , error = Nothing
    }


blank : Model
blank =
    initialModel Feed.empty


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        SearchChanged search ->
            ( { model | search = search }, Cmd.none )

        ToggleCollapsed feedId ->
            ( { model | collapsed = toggle feedId model.collapsed }, Cmd.none )

        ToggleExpanded key ->
            ( { model | expanded = toggle key model.expanded }, Cmd.none )

        SetFocus index ->
            ( { model | focusIndex = Just index }, Cmd.none )

        RowKey index key pressed ->
            rowKey index key pressed model

        CollapseAll collapse ->
            ( { model
                | collapsed =
                    if collapse then
                        Set.fromList (List.map (.feed >> .id) (visibleSections model))

                    else
                        Set.empty
              }
            , Cmd.none
            )

        KeepOne key ->
            keepOne key model

        DiscardSection feedId ->
            discardKeys (sectionKeys feedId model) model

        DiscardAll ->
            discardKeys (List.map (.item >> .key) (visibleRows model)) model

        Open url ->
            send IgnoreReply (Command.OpenLink url) model

        StartRename feedId currentTitle ->
            ( { model | renaming = Just { feedId = feedId, title = currentTitle } }, Cmd.none )

        RenameChanged title ->
            ( { model | renaming = Maybe.map (\entry -> { entry | title = title }) model.renaming }, Cmd.none )

        SaveRename ->
            saveRename model

        CancelRename ->
            ( { model | renaming = Nothing }, Cmd.none )

        Send pending command ->
            send pending command model

        Focused _ ->
            ( model, Cmd.none )

        NoOp ->
            ( model, Cmd.none )


{-| Sends one Item straight to the Inbox. Immediate, not marked-then-swept.
-}
keepOne : FeedItemKey -> Model -> ( Model, Cmd Msg )
keepOne key model =
    if busy model then
        ( model, Cmd.none )

    else
        send Working (Command.KeepItems [ key ]) model


discardKeys : List FeedItemKey -> Model -> ( Model, Cmd Msg )
discardKeys keys model =
    if busy model || List.isEmpty keys then
        ( model, Cmd.none )

    else
        send Working (Command.DiscardItems keys) model


{-| Submits a rename, or simply closes editing when nothing changed.
-}
saveRename : Model -> ( Model, Cmd Msg )
saveRename model =
    case model.renaming of
        Nothing ->
            ( model, Cmd.none )

        Just entry ->
            let
                title =
                    String.trim entry.title

                current =
                    model.feeds.feeds |> List.filter (\feed -> feed.id == entry.feedId) |> List.head |> Maybe.map .title
            in
            if String.isEmpty title || Just title == current then
                ( { model | renaming = Nothing }, Cmd.none )

            else
                send Working (Command.RenameFeed entry.feedId title) { model | renaming = Nothing }


rowKey : Int -> FeedItemKey -> Key -> Model -> ( Model, Cmd Msg )
rowKey index key pressed model =
    case pressed of
        ArrowDown ->
            ( model, focusRow (index + 1) model )

        ArrowUp ->
            ( model, focusRow (index - 1) model )

        Enter ->
            ( { model | expanded = toggle key model.expanded }, Cmd.none )

        Character "k" ->
            keepOne key model

        Character "o" ->
            case itemUrl .link key model of
                Just url ->
                    send IgnoreReply (Command.OpenLink url) model

                Nothing ->
                    ( model, Cmd.none )

        Character "c" ->
            case itemUrl .commentsUrl key model of
                Just url ->
                    send IgnoreReply (Command.OpenLink url) model

                Nothing ->
                    ( model, Cmd.none )

        Character "s" ->
            case sectionOf key model of
                Just feedId ->
                    discardKeys (sectionKeys feedId model) model

                Nothing ->
                    ( model, Cmd.none )

        _ ->
            ( model, Cmd.none )


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests }, feedsToHost (Host.envelope requestId (Command.encode command)) )


{-| Moves focus to a row by position. Walking off either end stays put.
-}
focusRow : Int -> Model -> Cmd Msg
focusRow index model =
    if index < 0 || index >= List.length (visibleRows model) then
        Cmd.none

    else
        Browser.Dom.focus (rowDomId index) |> Task.attempt Focused


{-| Focus after the list has shrunk: the row that took this position, or the new last one.
-}
focusNearest : Int -> Model -> Cmd Msg
focusNearest index model =
    let
        count =
            List.length (visibleRows model)
    in
    if count == 0 then
        Cmd.none

    else
        focusRow (min index (count - 1)) model


busy : Model -> Bool
busy model =
    List.any ((==) Working) (Host.pending model.requests)


toggle : comparable -> Set comparable -> Set comparable
toggle value values =
    if Set.member value values then
        Set.remove value values

    else
        Set.insert value values



-- HOST EVENTS


type HostEvent
    = FeedsEvent Feeds
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (FeedsEvent feeds) ->
            let
                present =
                    Feed.itemsOf feeds |> List.map .key |> Set.fromList
            in
            -- Expansion only means anything for an Item still on the list.
            ( { model | feeds = feeds, expanded = Set.intersect model.expanded present }, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests }
            in
            case outcome.result of
                Err message ->
                    ( { next | error = Just message }, Cmd.none )

                Ok _ ->
                    ( { next | error = Nothing }
                    , if pending == Just Working then
                        -- The row that took this one's place should be the one now focused.
                        Maybe.map (\index -> focusNearest index next) next.focusIndex |> Maybe.withDefault Cmd.none

                      else
                        Cmd.none
                    )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )



-- VIEW


type alias Section =
    { feed : Feed, items : List Item }


view : Model -> Html Msg
view model =
    let
        sections =
            visibleSections model

        openCount =
            List.length (visibleRows model)
    in
    div [ class "dg-view dg-feeds-view" ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 [] [ text "Feeds" ]
                , span [ class "dg-count" ] [ text (String.fromInt (Feed.totalUnread model.feeds)) ]
                ]
            , div [ class "dg-header-actions" ]
                [ if model.feeds.undoCount > 0 then
                    button
                        [ class "dg-feed-undo"
                        , title "Puts the last discard back. Nothing was written to the vault."
                        , onClick (Send Working Command.UndoDiscard)
                        ]
                        [ text ("Undo " ++ String.fromInt model.feeds.undoCount) ]

                  else
                    text ""
                , button [ onClick (Send IgnoreReply Command.OpenInbox) ] [ text "Inbox" ]
                , button [ onClick (Send IgnoreReply Command.AddFeed) ] [ text "Add feed…" ]
                , button
                    [ class "mod-cta"
                    , disabled (model.feeds.status == Feed.Fetching)
                    , onClick (Send Working Command.RefreshFeeds)
                    ]
                    [ text
                        (if model.feeds.status == Feed.Fetching then
                            "Fetching…"

                         else
                            "Fetch"
                        )
                    ]
                ]
            ]
        , Ui.maybeView model.error (\message -> div [ class "dg-warning" ] [ text message ])
        , if not model.feeds.enabled then
            emptyState "Feeds are switched off." "Turn them on in Dragonglass settings, then subscribe to a feed."

          else if List.isEmpty model.feeds.feeds then
            emptyState "No feeds yet." "Add one, and its Items appear here for triage."

          else
            div []
                [ toolbar model openCount sections
                , if List.isEmpty sections then
                    emptyState
                        (if String.isEmpty model.search then
                            "All caught up."

                         else
                            "Nothing matches this search."
                        )
                        (if String.isEmpty model.search then
                            "Every subscribed feed has been kept or discarded."

                         else
                            "Clear the search to see the rest."
                        )

                  else
                    div [ class "dg-feed-sections" ] (List.map (sectionView model (rowIndexes model)) sections)
                ]
        , footerView model
        ]


toolbar : Model -> Int -> List Section -> Html Msg
toolbar model openCount sections =
    let
        allCollapsed =
            not (List.isEmpty sections)
                && List.all (\entry -> Set.member entry.feed.id model.collapsed) sections
    in
    div [ class "dg-toolbar dg-feeds-toolbar" ]
        [ input [ type_ "search", placeholder "Search Feed Items", value model.search, onInput SearchChanged ] []
        , button
            [ disabled (List.isEmpty sections), onClick (CollapseAll (not allCollapsed)) ]
            [ text
                (if allCollapsed then
                    "Expand feeds"

                 else
                    "Collapse feeds"
                )
            ]
        , span [ class "dg-batch-spacer" ] []
        , button
            [ class "mod-warning dg-feed-discard"
            , title "Discards every Item shown in an open feed section."
            , disabled (openCount == 0 || busy model)
            , onClick DiscardAll
            ]
            [ text ("Discard all (" ++ String.fromInt openCount ++ ")") ]
        ]


sectionView : Model -> Dict FeedItemKey Int -> Section -> Html Msg
sectionView model indexes entry =
    let
        collapsed =
            Set.member entry.feed.id model.collapsed

        count =
            List.length entry.items
    in
    section [ class "dg-feed-section", classList [ ( "is-collapsed", collapsed ) ] ]
        [ div [ class "dg-feed-section-header" ]
            [ div [ class "dg-feed-section-heading" ]
                [ button
                    [ class "dg-feed-collapse"
                    , attribute "aria-expanded" (Ui.boolAttribute (not collapsed))
                    , onClick (ToggleCollapsed entry.feed.id)
                    ]
                    [ text
                        (if collapsed then
                            "▸"

                         else
                            "▾"
                        )
                    ]
                , div [ class "dg-feed-section-title" ]
                    (case model.renaming of
                        Just renaming ->
                            if renaming.feedId == entry.feed.id then
                                [ input
                                    [ class "dg-feed-rename"
                                    , value renaming.title
                                    , autofocus True
                                    , onInput RenameChanged
                                    , onBlur SaveRename
                                    , Ui.onKeyDown renameKey
                                    ]
                                    []
                                ]

                            else
                                titleView entry

                        Nothing ->
                            titleView entry
                    )
                ]
            , div [ class "dg-feed-section-controls" ]
                [ Ui.maybeView (nonEmpty entry.feed.error) (\message -> span [ class "dg-feed-error", title message ] [ text "Fetch failed" ])
                , button
                    [ class "mod-warning dg-feed-discard"
                    , title "Discards every Item shown in this feed."
                    , disabled (count == 0 || busy model)
                    , onClick (DiscardSection entry.feed.id)
                    ]
                    [ text ("Discard (" ++ String.fromInt count ++ ")") ]
                ]
            ]
        , if collapsed then
            text ""

          else
            div [ class "dg-feed-list", attribute "role" "list", attribute "aria-label" entry.feed.title ]
                (List.map (rowView model indexes) entry.items)
        ]


titleView : Section -> List (Html Msg)
titleView entry =
    [ h3 [ title entry.feed.url ] [ text entry.feed.title ]
    , span [ class "dg-count" ] [ text (String.fromInt (List.length entry.items)) ]
    , button
        [ class "dg-feed-rename-start"
        , title "Rename this feed"
        , onClick (StartRename entry.feed.id entry.feed.title)
        ]
        [ text "Rename" ]
    ]


renameKey : Key -> Msg
renameKey pressed =
    case pressed of
        Enter ->
            SaveRename

        Escape ->
            CancelRename

        _ ->
            NoOp


rowView : Model -> Dict FeedItemKey Int -> Item -> Html Msg
rowView model indexes item =
    let
        index =
            Dict.get item.key indexes |> Maybe.withDefault 0

        expanded =
            Set.member item.key model.expanded
    in
    article
        [ classList [ ( "dg-feed-row", True ), ( "is-expanded", expanded ) ]
        , attribute "role" "listitem"
        , id (rowDomId index)
        , tabindex 0
        , onFocus (SetFocus index)
        , Ui.onKeyDown (RowKey index item.key)
        ]
        [ div [ class "dg-feed-main" ]
            [ button [ class "dg-feed-title", onClick (ToggleExpanded item.key) ] [ text item.title ]
            , span [ class "dg-feed-meta" ] [ text (itemMeta item) ]
            , if expanded then
                p [ class "dg-feed-summary" ]
                    [ text
                        (if String.isEmpty item.summary then
                            "This Item carries no summary."

                         else
                            item.summary
                        )
                    ]

              else
                text ""
            ]
        , div [ class "dg-feed-row-actions" ]
            [ button [ disabled (String.isEmpty item.link), onClick (Open item.link) ] [ text "Open" ]
            , Ui.maybeView (nonEmpty item.commentsUrl)
                (\url -> button [ onClick (Open url) ] [ text "Comments" ])
            , button
                [ class "mod-cta"
                , disabled (busy model)
                , title "Sends this Item to the Inbox to be clarified there."
                , onClick (KeepOne item.key)
                ]
                [ text "Keep" ]
            ]
        ]


footerView : Model -> Html Msg
footerView model =
    if model.feeds.enabled then
        div [ class "dg-feed-status" ] [ small [] [ text (Feed.statusText model.feeds) ] ]

    else
        text ""


emptyState : String -> String -> Html Msg
emptyState heading detail =
    div [ class "dg-workflow-complete" ] [ h3 [] [ text heading ], p [] [ text detail ] ]


itemMeta : Item -> String
itemMeta item =
    [ item.age, item.author ] |> List.filter (String.isEmpty >> not) |> String.join " · "


rowDomId : Int -> String
rowDomId index =
    "dg-feed-row-" ++ String.fromInt index



-- QUERIES


{-| The feeds with Items the current search leaves visible, in subscription order.
-}
visibleSections : Model -> List Section
visibleSections model =
    model.feeds.feeds
        |> List.map (\feed -> { feed = feed, items = List.filter (matchesSearch model.search) feed.items })
        |> List.filter (\entry -> not (List.isEmpty entry.items))


{-| Every focusable row, in the order the keyboard walks them.
-}
visibleRows : Model -> List { feed : Feed, item : Item }
visibleRows model =
    visibleSections model
        |> List.filter (\entry -> not (Set.member entry.feed.id model.collapsed))
        |> List.concatMap (\entry -> List.map (\item -> { feed = entry.feed, item = item }) entry.items)


rowIndexes : Model -> Dict FeedItemKey Int
rowIndexes model =
    visibleRows model
        |> List.indexedMap (\index row -> ( row.item.key, index ))
        |> Dict.fromList


{-| The keys a section's Discard button would take — every Item currently shown in
that feed, collapsed or not, since discarding a specific feed is a deliberate act.
-}
sectionKeys : FeedId -> Model -> List FeedItemKey
sectionKeys feedId model =
    visibleSections model
        |> List.filter (\entry -> entry.feed.id == feedId)
        |> List.concatMap (.items >> List.map .key)


sectionOf : FeedItemKey -> Model -> Maybe FeedId
sectionOf key model =
    visibleSections model
        |> List.filter (\entry -> List.any (\item -> item.key == key) entry.items)
        |> List.head
        |> Maybe.map (.feed >> .id)


{-| The non-empty value a field accessor names for this Item, if any — used for whichever
URL a keyboard shortcut is opening.
-}
itemUrl : (Item -> String) -> FeedItemKey -> Model -> Maybe String
itemUrl field key model =
    Feed.itemsOf model.feeds
        |> List.filter (\item -> item.key == key)
        |> List.head
        |> Maybe.andThen (field >> nonEmpty)


matchesSearch : String -> Item -> Bool
matchesSearch search item =
    Ui.matches search [ item.title, item.author, item.summary ]


nonEmpty : String -> Maybe String
nonEmpty value =
    if String.isEmpty value then
        Nothing

    else
        Just value



-- DECODING


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "feeds" ->
                        Decode.map FeedsEvent (Decode.field "feeds" Feed.decoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
