port module Feeds exposing (main)

{-| Triage for subscribed feeds.

This is the list the Inbox deliberately is not. Processing an Inbox Item is one
decision at a time against a two-minute budget, because every capture there was
put there on purpose. A feed sends far more than it is owed, so almost every Item
earns one verdict — gone — and only a few are worth clarifying.

So the list is the surface rather than a way into a processor, keeping is a mark
rather than a write, and the button that matters sweeps a whole feed: the Items
marked to keep become Inbox Items and the rest are discarded together. Nothing
here is a vault file yet, which is why a sweep of two hundred rows is one write
and can be undone.

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
import Html.Attributes exposing (attribute, checked, class, classList, disabled, id, placeholder, tabindex, title, type_, value)
import Html.Events exposing (onCheck, onClick, onFocus, onInput)
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
    , kept : Set FeedItemKey
    , expanded : Set FeedItemKey
    , focusIndex : Maybe Int
    , requests : Requests Pending
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleCollapsed FeedId
    | SetKept FeedItemKey Bool
    | ToggleExpanded FeedItemKey
    | SetFocus Int
    | RowKey Int FeedItemKey Key
    | CollapseAll Bool
    | Sweep (List FeedItemKey) (List FeedItemKey)
    | Discard FeedItemKey
    | Process FeedItemKey
    | Open String
    | Send Pending Command
    | Focused (Result Browser.Dom.Error ())


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
    , kept = Set.empty
    , expanded = Set.empty
    , focusIndex = Nothing
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

        SetKept key kept ->
            ( { model
                | kept =
                    if kept then
                        Set.insert key model.kept

                    else
                        Set.remove key model.kept
              }
            , Cmd.none
            )

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

        Sweep keep discard ->
            sweep keep discard model

        Discard key ->
            send Working (Command.DiscardItems [ key ]) { model | kept = Set.remove key model.kept }

        Process key ->
            send Working (Command.ProcessItem key) { model | kept = Set.remove key model.kept }

        Open url ->
            send IgnoreReply (Command.OpenLink url) model

        Send pending command ->
            send pending command model

        Focused _ ->
            ( model, Cmd.none )


{-| Keeps and discards travel as two commands so a failed keep never discards anything.
-}
sweep : List FeedItemKey -> List FeedItemKey -> Model -> ( Model, Cmd Msg )
sweep keep discard model =
    if busy model || List.isEmpty (keep ++ discard) then
        ( model, Cmd.none )

    else
        let
            cleared =
                { model | kept = Set.diff model.kept (Set.fromList keep) }

            ( afterKeep, keepCmd ) =
                if List.isEmpty keep then
                    ( cleared, Cmd.none )

                else
                    send Working (Command.KeepItems keep) cleared

            ( afterDiscard, discardCmd ) =
                if List.isEmpty discard then
                    ( afterKeep, Cmd.none )

                else
                    send Working (Command.DiscardItems discard) afterKeep
        in
        ( afterDiscard, Cmd.batch [ keepCmd, discardCmd ] )


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
            ( { model | kept = toggle key model.kept }, Cmd.none )

        Character "d" ->
            send Working (Command.DiscardItems [ key ]) { model | kept = Set.remove key model.kept }

        Character "p" ->
            send Working (Command.ProcessItem key) { model | kept = Set.remove key model.kept }

        Character "o" ->
            case itemLink key model of
                Just url ->
                    send IgnoreReply (Command.OpenLink url) model

                Nothing ->
                    ( model, Cmd.none )

        Character "s" ->
            case sectionOf key model of
                Just rows ->
                    let
                        plan =
                            Feed.sweep model.kept rows
                    in
                    sweep plan.keep plan.discard model

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
            -- Marks and expansions only mean anything for Items still on the list.
            ( { model
                | feeds = feeds
                , kept = Set.intersect model.kept present
                , expanded = Set.intersect model.expanded present
              }
            , Cmd.none
            )

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
                        Maybe.map (\index -> focusRow index next) next.focusIndex |> Maybe.withDefault Cmd.none

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

        rows =
            visibleRows model

        plan =
            Feed.sweep model.kept (List.map .item rows)
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
                        , title "Puts the last sweep back. Nothing was written to the vault."
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
                [ toolbar model plan sections
                , if List.isEmpty sections then
                    emptyState
                        (if String.isEmpty model.search then
                            "All caught up."

                         else
                            "Nothing matches this search."
                        )
                        (if String.isEmpty model.search then
                            "Every subscribed feed has been swept."

                         else
                            "Clear the search to see the rest."
                        )

                  else
                    div [ class "dg-feed-sections" ] (List.map (sectionView model (rowIndexes model)) sections)
                ]
        , footerView model
        ]


toolbar : Model -> Feed.Sweep -> List Section -> Html Msg
toolbar model plan sections =
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
            [ class "mod-cta dg-feed-sweep"
            , title "Keeps what is marked and discards the rest, across every open feed section."
            , disabled (not plan.ready || busy model)
            , onClick (Sweep plan.keep plan.discard)
            ]
            [ text plan.label ]
        ]


sectionView : Model -> Dict FeedItemKey Int -> Section -> Html Msg
sectionView model indexes entry =
    let
        collapsed =
            Set.member entry.feed.id model.collapsed

        plan =
            Feed.sweep model.kept entry.items
    in
    section [ class "dg-feed-section", classList [ ( "is-collapsed", collapsed ) ] ]
        [ div [ class "dg-feed-section-header" ]
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
                [ h3 [ title entry.feed.url ] [ text entry.feed.title ]
                , span [ class "dg-count" ] [ text (String.fromInt (List.length entry.items)) ]
                ]
            , Ui.maybeView (nonEmpty entry.feed.error) (\message -> span [ class "dg-feed-error", title message ] [ text "Fetch failed" ])
            , button
                [ class "dg-feed-sweep"
                , title "Keeps what is marked in this feed and discards the rest."
                , disabled (not plan.ready || busy model)
                , onClick (Sweep plan.keep plan.discard)
                ]
                [ text plan.label ]
            ]
        , if collapsed then
            text ""

          else
            div [ class "dg-feed-list", attribute "role" "list", attribute "aria-label" entry.feed.title ]
                (List.map (rowView model indexes) entry.items)
        ]


rowView : Model -> Dict FeedItemKey Int -> Item -> Html Msg
rowView model indexes item =
    let
        index =
            Dict.get item.key indexes |> Maybe.withDefault 0

        kept =
            Set.member item.key model.kept

        expanded =
            Set.member item.key model.expanded
    in
    article
        [ classList [ ( "dg-feed-row", True ), ( "is-kept", kept ), ( "is-expanded", expanded ) ]
        , attribute "role" "listitem"
        , id (rowDomId index)
        , tabindex 0
        , onFocus (SetFocus index)
        , Ui.onKeyDown (RowKey index item.key)
        ]
        [ Html.label
            [ class "dg-feed-keep", title "Keep this Item. A sweep sends every marked Item to the Inbox." ]
            [ input [ type_ "checkbox", checked kept, onCheck (SetKept item.key) ] []
            , span [] [ text "Keep" ]
            ]
        , div [ class "dg-feed-main" ]
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
            , button [ disabled (busy model), onClick (Process item.key) ] [ text "Process" ]
            , button [ class "mod-warning", disabled (busy model), onClick (Discard item.key) ] [ text "Discard" ]
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


sectionOf : FeedItemKey -> Model -> Maybe (List Item)
sectionOf key model =
    visibleSections model
        |> List.filter (\entry -> List.any (\item -> item.key == key) entry.items)
        |> List.head
        |> Maybe.map .items


itemLink : FeedItemKey -> Model -> Maybe String
itemLink key model =
    Feed.itemsOf model.feeds
        |> List.filter (\item -> item.key == key && not (String.isEmpty item.link))
        |> List.head
        |> Maybe.map .link


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
