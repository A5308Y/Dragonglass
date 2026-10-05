port module Inbox exposing (main)

import Browser
import Browser.Dom
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Command as Base exposing (ScheduleInput(..))
import Gtd.Command.Inbox as Command exposing (Command, Disposition(..))
import Gtd.Data as Data exposing (InboxItem, Project, Snapshot)
import Gtd.Energy as Energy exposing (Energy)
import Gtd.Estimate as Estimate
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (InboxItemId, ProjectId)
import Gtd.Picker as Picker exposing (Picker)
import Gtd.Ui as Ui exposing (Key(..))
import Html exposing (Html, article, audio, button, div, h2, h3, header, input, label, node, option, p, section, select, small, span, strong, text, textarea)
import Html.Attributes exposing (attribute, checked, class, classList, controls, id, placeholder, preload, selected, src, style, tabindex, title, type_, value)
import Html.Events exposing (onCheck, onClick, onInput)
import Html.Keyed
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Task
import Time


port inboxToHost : Encode.Value -> Cmd msg


port inboxFromHost : (Decode.Value -> msg) -> Sub msg


{-| The decision budget for one Inbox Item.
-}
decisionSeconds : Int
decisionSeconds =
    120


{-| What a host reply should finish, and for which Item.
-}
type Pending
    = IgnoreReply
    | LoadBody InboxItemId
    | LoadPreview InboxItemId
    | Working InboxItemId
    | LoadOutcome ProjectId


type alias ScheduleFields =
    { allDay : Bool, start : String, duration : String }


type alias Model =
    { snapshot : Snapshot

    -- Active Projects with an issue: Inbox zero waits until there are none.
    , projectIssues : Int
    , hostSnapshot : Snapshot
    , setAside : Dict InboxItemId String
    , search : String
    , processing : Bool
    , cursor : Int
    , requested : Maybe InboxItemId
    , sessionTotal : Int
    , seconds : Int
    , body : Maybe LoadedBody
    , selected : Maybe InboxItemId
    , preview : Maybe LoadedBody
    , previewRequested : Maybe InboxItemId
    , project : Picker Project
    , context : Picker String
    , desiredOutcome : String

    -- The vision last loaded from the chosen Project, to tell it from text typed here.
    , loadedOutcome : Maybe { projectId : ProjectId, text : String }
    , nextAction : String
    , actionStatus : ActionStatus
    , waitingSince : String
    , followUp : String
    , energy : Maybe Energy
    , estimate : Maybe Int
    , schedule : ScheduleFields
    , someday : Bool
    , backlog : Bool
    , fileOriginal : Bool
    , requests : Requests Pending
    , error : Maybe String

    -- The tab was closed: timers off (see `Host.isClosing`).
    , closed : Bool
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | SearchChanged String
    | StartProcessing (Maybe InboxItemId)
    | ShowList
    | ProjectPicker (Picker.PickerMsg Project)
    | ContextPicker (Picker.PickerMsg String)
    | DesiredOutcomeChanged String
    | NextActionChanged String
    | ActionStatusChanged ActionStatus
    | WaitingSinceChanged String
    | FollowUpChanged String
    | EnergyChanged (Maybe Energy)
    | EstimateChanged (Maybe Int)
    | SetAllDay Bool
    | ScheduledStartChanged String
    | ScheduledDurationChanged String
    | SetSomeday Bool
    | SetBacklog Bool
    | SetFileOriginal Bool
    | DeleteItem InboxItemId
    | ReviewPullRequest InboxItemId
    | ProcessItem
    | RowKey InboxItemId Key
    | SelectRow InboxItemId
    | ProcessorChord Chord
    | Focused
    | Send Pending Command


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init >> withPreview
        , update = \msg model -> update msg model |> withPreview
        , subscriptions = subscriptions
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot, initialProcessing : Bool, projectIssues : Int }


init : Decode.Value -> ( Model, Cmd Msg )
init flagsValue =
    case Decode.decodeValue flagsDecoder flagsValue of
        Ok flags ->
            let
                model =
                    initialModel flags.snapshot |> (\initial -> { initial | projectIssues = flags.projectIssues })
            in
            if flags.initialProcessing && not (List.isEmpty flags.snapshot.inboxItems) then
                enterProcessing Nothing model

            else
                ( model, Cmd.none )

        Err error ->
            ( { blank | error = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Snapshot -> Model
initialModel snapshot =
    { snapshot = snapshot
    , hostSnapshot = snapshot
    , projectIssues = 0
    , setAside = Dict.empty
    , search = ""
    , processing = False
    , cursor = 0
    , requested = Nothing
    , sessionTotal = 0
    , seconds = decisionSeconds
    , body = Nothing
    , selected = Nothing
    , preview = Nothing
    , previewRequested = Nothing
    , project = Picker.init "" Nothing
    , context = Picker.init "" Nothing
    , desiredOutcome = ""
    , loadedOutcome = Nothing
    , nextAction = ""
    , actionStatus = ActionStatus.Next
    , waitingSince = snapshot.today
    , followUp = ""
    , energy = Nothing
    , estimate = Nothing
    , schedule = { allDay = False, start = "", duration = String.fromInt snapshot.settings.defaultDurationMinutes }
    , someday = False
    , backlog = False
    , fileOriginal = False
    , requests = Host.noRequests
    , error = Nothing
    , closed = False
    }


blank : Model
blank =
    initialModel Data.empty


subscriptions : Model -> Sub Msg
subscriptions model =
    if model.closed then
        Sub.none

    else
        subscriptionsWhileOpen model


subscriptionsWhileOpen : Model -> Sub Msg
subscriptionsWhileOpen model =
    Sub.batch
        [ inboxFromHost GotHost
        , if model.processing then
            Time.every 1000 Tick

          else
            Sub.none
        ]


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            if Host.isClosing value then
                ( { model | closed = True }, Cmd.none )

            else
                receiveHost value model

        Tick _ ->
            ( { model | seconds = max 0 (model.seconds - 1) }, Cmd.none )

        SearchChanged search ->
            ( { model | search = search }, Cmd.none )

        StartProcessing maybeId ->
            enterProcessing maybeId model

        ShowList ->
            ( { model | processing = False }, Cmd.none )

        ProjectPicker pickerMsg ->
            let
                picked =
                    Picker.update pickerMsg (projectSuggestions model) (Hierarchy.breadcrumb model.snapshot.projects) model.project

                chosen =
                    Picker.selection picked |> Maybe.map .id

                -- A vision loaded from the Project before goes with it, unless it was edited here.
                untouched =
                    String.isEmpty (String.trim model.desiredOutcome)
                        || Maybe.map .text model.loadedOutcome == Just model.desiredOutcome

                next =
                    if untouched then
                        { model | project = picked, desiredOutcome = "", loadedOutcome = Nothing }

                    else
                        { model | project = picked }
            in
            if chosen == (Picker.selection model.project |> Maybe.map .id) then
                ( { model | project = picked }, Cmd.none )

            else
                case chosen of
                    Just projectId ->
                        send (LoadOutcome projectId) (Command.ReadDesiredOutcome projectId) next

                    Nothing ->
                        ( next, Cmd.none )

        ContextPicker pickerMsg ->
            ( { model | context = Picker.update pickerMsg (contextSuggestions model) identity model.context }, Cmd.none )

        DesiredOutcomeChanged desiredOutcome ->
            ( { model | desiredOutcome = desiredOutcome }, Cmd.none )

        NextActionChanged nextAction ->
            ( { model | nextAction = nextAction }, Cmd.none )

        ActionStatusChanged actionStatus ->
            ( { model | actionStatus = actionStatus }, Cmd.none )

        WaitingSinceChanged waitingSince ->
            ( { model | waitingSince = waitingSince }, Cmd.none )

        FollowUpChanged followUp ->
            ( { model | followUp = followUp }, Cmd.none )

        EnergyChanged energy ->
            ( { model | energy = energy }, Cmd.none )

        EstimateChanged estimate ->
            ( { model | estimate = estimate }, Cmd.none )

        SetAllDay allDay ->
            let
                schedule =
                    model.schedule
            in
            ( { model
                | schedule =
                    { schedule
                        | allDay = allDay
                        , start =
                            if allDay then
                                String.left 10 schedule.start

                            else if String.isEmpty schedule.start then
                                ""

                            else
                                String.left 10 schedule.start ++ "T09:00"
                    }
              }
            , Cmd.none
            )

        ScheduledStartChanged start ->
            let
                schedule =
                    model.schedule
            in
            ( { model | schedule = { schedule | start = start } }, Cmd.none )

        ScheduledDurationChanged duration ->
            let
                schedule =
                    model.schedule
            in
            ( { model | schedule = { schedule | duration = duration } }, Cmd.none )


        -- Someday/Maybe and Backlog both park the Project instead of activating it, so
        -- at most one of them is on.
        SetSomeday someday ->
            ( { model | someday = someday, backlog = model.backlog && not someday }, Cmd.none )

        SetBacklog backlog ->
            ( { model | backlog = backlog, someday = model.someday && not backlog }, Cmd.none )

        SetFileOriginal fileOriginal ->
            ( { model | fileOriginal = fileOriginal }, Cmd.none )

        ReviewPullRequest itemId ->
            sendForItem itemId (Command.ReviewPullRequest itemId) model

        DeleteItem itemId ->
            let
                ( next, cmd ) =
                    sendForItem itemId (Command.TrashInboxItem itemId) model
            in
            -- In the list, focus stays on the row that takes the deleted one's place.
            if model.processing then
                ( next, cmd )

            else
                selectRow (neighbourRow itemId model) next |> Tuple.mapSecond (\focusCmd -> Cmd.batch [ cmd, focusCmd ])

        SelectRow itemId ->
            ( { model | selected = Just itemId }, Cmd.none )

        RowKey focusedId key ->
            let
                -- The keys act on the selected Item, the one both markers show, even
                -- if focus has not caught up with the selection yet.
                itemId =
                    selectedItem model |> Maybe.map .id |> Maybe.withDefault focusedId
            in
            case key of
                ArrowDown ->
                    selectRow (adjacentRow 1 itemId model) model

                ArrowUp ->
                    selectRow (adjacentRow -1 itemId model) model

                Enter ->
                    enterProcessing (Just itemId) model

                Character "o" ->
                    case List.filter (\item -> item.id == itemId) model.snapshot.inboxItems of
                        item :: _ ->
                            send IgnoreReply (Command.OpenFile item.file.path) model

                        [] ->
                            ( model, Cmd.none )

                Character "x" ->
                    update (DeleteItem itemId) model

                Delete ->
                    update (DeleteItem itemId) model

                Backspace ->
                    update (DeleteItem itemId) model

                _ ->
                    ( model, Cmd.none )

        ProcessorChord chord ->
            case ( chord, currentItem model ) of
                ( ProcessChord, _ ) ->
                    update ProcessItem model

                ( DeleteChord, Just item ) ->
                    update (DeleteItem item.id) model

                ( DeleteChord, Nothing ) ->
                    ( model, Cmd.none )

        Focused ->
            ( model, Cmd.none )

        ProcessItem ->
            case currentItem model of
                Nothing ->
                    ( model, Cmd.none )

                Just item ->
                    let
                        decision =
                            disposition model
                    in
                    if not decision.ready then
                        ( model, Cmd.none )

                    else if Set.member item.id (busyItems model) then
                        ( model, Cmd.none )

                    else
                        processAndMoveOn item.id (Command.ProcessInbox item.id decision.operation (processingInput model)) model

        Send pending command ->
            send pending command model


{-| Moves the selection and focus together, so the row that shows as selected is
the one the keys act on.
-}
selectRow : Maybe InboxItemId -> Model -> ( Model, Cmd Msg )
selectRow maybeId model =
    case maybeId of
        Just itemId ->
            ( { model | selected = Just itemId }, focusRow (Just itemId) )

        Nothing ->
            ( model, Cmd.none )


enterProcessing : Maybe InboxItemId -> Model -> ( Model, Cmd Msg )
enterProcessing maybeId model =
    let
        items =
            sortedItems model.snapshot.inboxItems

        found =
            maybeId |> Maybe.andThen (\wanted -> indexOf wanted items)
    in
    resetCurrent
        { model
            | processing = True
            , cursor = Maybe.withDefault 0 found
            , requested =
                -- A named Item written a moment ago may not be indexed yet, so the
                -- request outlives this snapshot rather than silently landing on another Item.
                if found == Nothing then
                    maybeId

                else
                    Nothing
            , sessionTotal = List.length items
        }


resetCurrent : Model -> ( Model, Cmd Msg )
resetCurrent model =
    case currentItem model of
        Nothing ->
            ( { model | body = Nothing }, Cmd.none )

        Just item ->
            let
                prefill =
                    String.left 100 item.title
            in
            send (LoadBody item.id)
                (Command.ReadInboxBody item.id)
                { model
                    | seconds = decisionSeconds
                    , body = Nothing
                    , project = Picker.init prefill Nothing
                    , context = Picker.init "" Nothing
                    , desiredOutcome = ""
                    , loadedOutcome = Nothing
                    , nextAction = prefill
                    , actionStatus = ActionStatus.Next
                    , waitingSince = model.snapshot.today
                    , followUp = ""
                    , energy = Nothing
                    , estimate = Nothing
                    , schedule = { allDay = False, start = "", duration = String.fromInt model.snapshot.settings.defaultDurationMinutes }
                    , someday = False
                    , backlog = False
                    , fileOriginal = False
                    , error = Nothing
                }
                |> Tuple.mapSecond (\loadCmd -> Cmd.batch [ loadCmd, focus nextActionId ])


{-| The two shortcuts the processor answers from anywhere inside it.
-}
type Chord
    = ProcessChord
    | DeleteChord


{-| ⌘/Ctrl+Shift+Backspace deletes and moves on. Plain ⌘/Ctrl+Backspace is left
alone, because it deletes text in a field. ⌘/Ctrl+Enter, which processes, comes
through `Ui.onModEnter`, since Obsidian's keymap takes ⌘+Enter first.
-}
onProcessorChord : Html.Attribute Msg
onProcessorChord =
    Html.Events.custom "keydown"
        (Decode.map4
            (\key meta ctrl shift ->
                let
                    modifier =
                        meta || ctrl
                in
                if modifier && shift && key == "Backspace" then
                    Decode.succeed { message = ProcessorChord DeleteChord, stopPropagation = True, preventDefault = True }

                else
                    Decode.fail "not a processor shortcut"
            )
            (Decode.field "key" Decode.string)
            (Decode.field "metaKey" Decode.bool)
            (Decode.field "ctrlKey" Decode.bool)
            (Decode.field "shiftKey" Decode.bool)
            |> Decode.andThen identity
        )


{-| Keys pressed on the row itself; a key on one of its buttons is that button's.
The arrows only move the selection: moving focus scrolls the list when the new
row is out of view, so the browser's own arrow scrolling is cancelled.
-}
onRowKey : InboxItemId -> Html.Attribute Msg
onRowKey itemId =
    Html.Events.preventDefaultOn "keydown"
        (Decode.at [ "target", "id" ] Decode.string
            |> Decode.andThen
                (\targetId ->
                    if targetId == rowId itemId then
                        Decode.map (\key -> ( RowKey itemId key, key == ArrowDown || key == ArrowUp )) Ui.keyDecoder

                    else
                        Decode.fail "key on a child of the row"
                )
        )


nextActionId : String
nextActionId =
    "dg-inbox-next-action"


rowId : InboxItemId -> String
rowId itemId =
    "dg-inbox-row-" ++ itemId


focus : String -> Cmd Msg
focus domId =
    Browser.Dom.focus domId |> Task.attempt (\_ -> Focused)


listId : String
listId =
    "dg-inbox-list"


{-| Focuses a row, scrolling the list only as far as needed to show it, as a mail
client does. Focus alone would scroll an out-of-view row to the middle of the list.
-}
focusRow : Maybe InboxItemId -> Cmd Msg
focusRow maybeId =
    case maybeId of
        Nothing ->
            Cmd.none

        Just itemId ->
            Task.map3 revealRow
                (Browser.Dom.getElement (rowId itemId))
                (Browser.Dom.getElement listId)
                (Browser.Dom.getViewportOf listId)
                |> Task.andThen identity
                |> Task.andThen (\_ -> Browser.Dom.focus (rowId itemId))
                |> Task.attempt (\_ -> Focused)


revealRow : Browser.Dom.Element -> Browser.Dom.Element -> Browser.Dom.Viewport -> Task.Task Browser.Dom.Error ()
revealRow row list viewport =
    let
        top =
            row.element.y - list.element.y

        bottom =
            top + row.element.height

        scrollTop =
            viewport.viewport.y
    in
    if top < 0 then
        Browser.Dom.setViewportOf listId 0 (scrollTop + top)

    else if bottom > viewport.viewport.height then
        Browser.Dom.setViewportOf listId 0 (scrollTop + bottom - viewport.viewport.height)

    else
        Task.succeed ()


{-| The Item the list's reading pane shows: the selected row, or the first one
until a row is selected or after the selected one has gone.
-}
selectedItem : Model -> Maybe InboxItem
selectedItem model =
    let
        items =
            listedItems model
    in
    case List.filter (\item -> Just item.id == model.selected) items of
        item :: _ ->
            Just item

        [] ->
            List.head items


{-| Loads the reading pane's text whenever the shown Item changes.
-}
withPreview : ( Model, Cmd Msg ) -> ( Model, Cmd Msg )
withPreview ( model, cmd ) =
    case ( model.processing, selectedItem model ) of
        ( False, Just item ) ->
            if model.previewRequested == Just item.id then
                ( model, cmd )

            else
                send (LoadPreview item.id) (Command.ReadInboxBody item.id) { model | previewRequested = Just item.id }
                    |> Tuple.mapSecond (\loadCmd -> Cmd.batch [ cmd, loadCmd ])

        _ ->
            ( model, cmd )


{-| The rows the list shows, in order: the search narrows them.
-}
listedItems : Model -> List InboxItem
listedItems model =
    sortedItems model.snapshot.inboxItems
        |> List.filter (\item -> Ui.matches model.search [ item.title ])


adjacentRow : Int -> InboxItemId -> Model -> Maybe InboxItemId
adjacentRow offset itemId model =
    let
        ids =
            List.map .id (listedItems model)
    in
    indexOfId itemId ids
        |> Maybe.andThen (\index -> List.drop (index + offset) ids |> List.head)


{-| The row that takes a deleted row's place: the one after it, or else the one before.
-}
neighbourRow : InboxItemId -> Model -> Maybe InboxItemId
neighbourRow itemId model =
    case adjacentRow 1 itemId model of
        Just next ->
            Just next

        Nothing ->
            adjacentRow -1 itemId model


indexOfId : InboxItemId -> List InboxItemId -> Maybe Int
indexOfId wanted ids =
    ids
        |> List.indexedMap Tuple.pair
        |> List.filter (\( _, id ) -> id == wanted)
        |> List.head
        |> Maybe.map Tuple.first


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests }, inboxToHost (Host.envelope requestId (Command.encode command)) )


{-| Processes an Item and moves straight on to the next one while the host writes,
so a slow vault never holds up the Inbox. A failure brings the Item back.
-}
processAndMoveOn : InboxItemId -> Command -> Model -> ( Model, Cmd Msg )
processAndMoveOn itemId command model =
    let
        ( sent, sendCmd ) =
            send (Working itemId) command model

        path =
            List.filter (\item -> item.id == itemId) model.hostSnapshot.inboxItems
                |> List.head
                |> Maybe.map (\item -> item.file.path)
                |> Maybe.withDefault ""

        setAside =
            Dict.insert itemId path sent.setAside

        moved =
            { sent | setAside = setAside, snapshot = withoutSetAside setAside sent.hostSnapshot }

        ( next, resetCmd ) =
            if model.processing then
                resetCurrent moved

            else
                ( moved, Cmd.none )
    in
    ( next, Cmd.batch [ sendCmd, resetCmd ] )


withoutSetAside : Dict InboxItemId String -> Snapshot -> Snapshot
withoutSetAside setAside snapshot =
    if Dict.isEmpty setAside then
        snapshot

    else
        let
            paths =
                Set.fromList (Dict.values setAside)

            hidden item =
                Dict.member item.id setAside || Set.member item.file.path paths
        in
        { snapshot | inboxItems = List.filter (not << hidden) snapshot.inboxItems }


{-| One command per Item at a time: a second click while a write is in flight is a slip.
-}
sendForItem : InboxItemId -> Command -> Model -> ( Model, Cmd Msg )
sendForItem itemId command model =
    if Set.member itemId (busyItems model) then
        ( model, Cmd.none )

    else
        send (Working itemId) command model


{-| The Items with a write in flight, read straight from the requests still open.
-}
busyItems : Model -> Set InboxItemId
busyItems model =
    Host.pending model.requests
        |> List.filterMap
            (\pending ->
                case pending of
                    Working itemId ->
                        Just itemId

                    _ ->
                        Nothing
            )
        |> Set.fromList



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | StartProcessingEvent (Maybe InboxItemId)
    | ProjectIssuesEvent Int
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent hostSnapshot) ->
            let
                -- An Item stays set aside until its file has left the Inbox. Keyed by path, since
                -- a capture half-way through becoming an Action briefly reads as another Item.
                setAside =
                    Dict.filter (\_ path -> List.any (\item -> item.file.path == path) hostSnapshot.inboxItems) model.setAside

                snapshot =
                    withoutSetAside setAside hostSnapshot

                next =
                    { model | snapshot = snapshot, hostSnapshot = hostSnapshot, setAside = setAside }

                arrived =
                    model.requested |> Maybe.andThen (\wanted -> indexOf wanted (sortedItems snapshot.inboxItems))
            in
            case arrived of
                Just cursor ->
                    resetCurrent
                        { next
                            | processing = True
                            , cursor = cursor
                            , requested = Nothing
                            , sessionTotal = List.length snapshot.inboxItems
                        }

                Nothing ->
                    let
                        previousId =
                            currentItem model |> Maybe.map .id

                        nextId =
                            currentItem next |> Maybe.map .id
                    in
                    if model.processing && previousId /= nextId then
                        resetCurrent next

                    else
                        ( next, Cmd.none )

        Ok (ProjectIssuesEvent count) ->
            ( { model | projectIssues = count }, Cmd.none )

        Ok (StartProcessingEvent maybeId) ->
            -- Opening the processor again is a no-op, but naming an Item always moves to it.
            if model.processing && maybeId == Nothing then
                ( model, Cmd.none )

            else
                enterProcessing maybeId model

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests }
            in
            case ( outcome.result, Maybe.withDefault IgnoreReply pending ) of
                ( Err message, Working itemId ) ->
                    -- Processing failed, so the Item comes back to the Inbox with the reason.
                    let
                        setAside =
                            Dict.remove itemId next.setAside

                        title =
                            List.filter (\item -> item.id == itemId) next.hostSnapshot.inboxItems
                                |> List.head
                                |> Maybe.map (\item -> "Could not process “" ++ item.title ++ "”: ")
                                |> Maybe.withDefault ""
                    in
                    ( { next
                        | error = Just (title ++ message)
                        , setAside = setAside
                        , snapshot = withoutSetAside setAside next.hostSnapshot
                      }
                    , Cmd.none
                    )

                ( Err message, _ ) ->
                    ( { next | error = Just message }, Cmd.none )

                ( Ok resultValue, LoadBody itemId ) ->
                    if (currentItem model |> Maybe.map .id) == Just itemId then
                        ( { next | body = Just (loadedBody itemId resultValue) }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Ok resultValue, LoadOutcome projectId ) ->
                    let
                        vision =
                            Decode.decodeValue Decode.string resultValue |> Result.withDefault ""

                        stillChosen =
                            (Picker.selection next.project |> Maybe.map .id) == Just projectId

                        -- Filled only while nothing was typed in the meantime.
                        free =
                            String.isEmpty (String.trim next.desiredOutcome)
                    in
                    if stillChosen && free && not (String.isEmpty (String.trim vision)) then
                        ( { next | desiredOutcome = vision, loadedOutcome = Just { projectId = projectId, text = vision } }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Ok resultValue, LoadPreview itemId ) ->
                    if next.previewRequested == Just itemId then
                        ( { next | preview = Just (loadedBody itemId resultValue) }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Ok _, _ ) ->
                    ( { next | error = Nothing }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )


{-| An Item's text as the host read it, and the GitHub pull request it links, named
like `dragonglass#123`, which offers + Review while processing.
-}
type alias LoadedBody =
    { itemId : InboxItemId, text : String, pullRequest : Maybe String }


loadedBody : InboxItemId -> Decode.Value -> LoadedBody
loadedBody itemId value =
    Decode.decodeValue
        (Decode.map2 (LoadedBody itemId)
            (Decode.field "text" Decode.string)
            (Decode.field "pullRequest" (Decode.nullable Decode.string))
        )
        value
        |> Result.withDefault { itemId = itemId, text = "", pullRequest = Nothing }



-- VIEW


view : Model -> Html Msg
view model =
    div [ classList [ ( "dg-view dg-inbox-view", True ), ( "is-processing", model.processing ) ] ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 []
                    [ text
                        (if model.processing then
                            "Process Inbox"

                         else
                            "Inbox"
                        )
                    ]
                , span [ class "dg-count" ] [ text (String.fromInt (List.length model.snapshot.inboxItems)) ]
                ]
            , div [ class "dg-header-actions" ]
                [ if model.processing then
                    button [ onClick ShowList ] [ text "Back to list" ]

                  else
                    button [ Html.Attributes.disabled (List.isEmpty model.snapshot.inboxItems), onClick (StartProcessing Nothing) ] [ text "Process Inbox" ]
                , button [ class "mod-cta", onClick (Send IgnoreReply Command.QuickCapture) ] [ text "Capture" ]
                ]
            ]
        , Ui.issuesView (\path -> Send IgnoreReply (Command.OpenFile path)) model.snapshot.issues
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , if model.processing then
            processorView model

          else
            listView model
        ]


{-| The empty Inbox. It is Inbox zero only once no Project is stuck either: an Active
Project without a next step is a loose end as much as an unprocessed capture.
-}
emptyInbox : Model -> Html Msg
emptyInbox model =
    if model.projectIssues > 0 then
        div [ class "dg-inbox-zero dg-inbox-almost" ]
            [ h3 [] [ text "The Inbox is empty" ]
            , p []
                [ text
                    (Ui.plural model.projectIssues "Project"
                        ++ (if model.projectIssues == 1 then
                                " still needs"

                            else
                                " still need"
                           )
                        ++ " a next step. Once each has one, it’s Inbox zero."
                    )
                ]
            , button [ class "mod-cta", onClick (Send IgnoreReply Command.ShowProjectIssues) ] [ text "Show Project issues" ]
            ]

    else
        inboxZero


{-| Inbox zero, in the list and at the end of processing: a quiet moment worth
marking, so it gets a picture (drawn in `styles.css`) rather than a line of text.
-}
inboxZero : Html msg
inboxZero =
    div [ class "dg-inbox-zero" ]
        [ div [ class "dg-inbox-zero-art", attribute "aria-hidden" "true" ] []
        , h3 [] [ text "Inbox zero" ]
        , p [] [ text "Everything captured has been clarified." ]
        ]


listView : Model -> Html Msg
listView model =
    let
        items =
            listedItems model
    in
    div [ class "dg-inbox-mail" ]
        [ div [ class "dg-toolbar dg-inbox-toolbar" ]
            [ input [ type_ "search", placeholder "Search Inbox", value model.search, onInput SearchChanged ] []
            , span [ class "dg-shortcut-hint" ] [ text "↑↓ move · ⌫ delete · Enter process · O open" ]
            ]
        , if List.isEmpty model.snapshot.inboxItems then
            emptyInbox model

          else
            -- Keyed, so a row's element stays with its Item: unkeyed, deleting an Item made
            -- the focused element show the Item after the selected one, and a click on it
            -- selected nothing, as the element already had focus.
            Html.Keyed.node "div"
                [ class "dg-inbox-list", id listId, attribute "role" "list" ]
                (if List.isEmpty items then
                    [ ( "", div [ class "dg-empty-row" ] [ text "No Inbox Items match this search." ] ) ]

                 else
                    List.map (\item -> ( item.id, inboxRow (selectedItem model |> Maybe.map .id) item )) items
                )
        , Ui.maybeView (selectedItem model) (readingPane model)
        ]


{-| One line per Item, as in a mail client: a click or the arrow keys select it
for the reading pane, a double click opens it.
-}
inboxRow : Maybe InboxItemId -> InboxItem -> Html Msg
inboxRow selectedId item =
    article
        [ classList [ ( "dg-inbox-row", True ), ( "is-selected", selectedId == Just item.id ) ]
        , attribute "role" "listitem"
        , attribute "aria-current" (Ui.boolAttribute (selectedId == Just item.id))
        , id (rowId item.id)
        , tabindex 0
        , onRowKey item.id
        , Html.Events.on "focusin" (Decode.succeed (SelectRow item.id))
        , onClick (SelectRow item.id)
        , Html.Events.on "dblclick" (Decode.succeed (Send IgnoreReply (Command.OpenFile item.file.path)))
        ]
        [ span [ class "dg-inbox-row-title" ] [ text item.title ]
        , span [ class "dg-inbox-meta" ] [ text (itemMeta item) ]
        ]


{-| An Item's note, rendered by Obsidian as it would show in the note itself.
-}
markdownView : String -> String -> InboxItem -> Html Msg
markdownView className markdown item =
    node "dg-markdown"
        [ class (className ++ " markdown-rendered")
        , attribute "data-markdown" markdown
        , attribute "data-source-path" item.file.path
        ]
        []


{-| The selected Item in full, below the list, with what can be done to it.
-}
readingPane : Model -> InboxItem -> Html Msg
readingPane model item =
    let
        busy =
            Set.member item.id (busyItems model)

        body =
            case model.preview of
                Just loaded ->
                    if loaded.itemId == item.id then
                        Just loaded.text

                    else
                        Nothing

                Nothing ->
                    Nothing
    in
    section [ class "dg-inbox-reading" ]
        [ div [ class "dg-inbox-reading-heading" ]
            [ div [] [ h3 [] [ text item.title ], span [ class "dg-inbox-meta" ] [ text (itemMeta item) ] ]
            , div [ class "dg-inbox-row-actions" ]
                (mailButton item
                    ++ [ button [ onClick (Send IgnoreReply (Command.OpenFile item.file.path)) ]
                            [ text
                                (if item.file.extension == "md" then
                                    "Open note"

                                 else
                                    "Open file"
                                )
                            ]
                       , button [ class "mod-cta", Html.Attributes.disabled busy, onClick (StartProcessing (Just item.id)) ] [ text "Process" ]
                       , button [ class "mod-warning", Html.Attributes.disabled busy, onClick (DeleteItem item.id) ] [ text "Delete" ]
                       ]
                )
            ]
        , if isAudio item.file.extension then
            audio [ class "dg-inbox-audio", controls True, preload "metadata", src item.resourceUrl ] []

          else
            case body of
                Nothing ->
                    div [ class "dg-inbox-reading-body is-empty" ] [ text "Loading…" ]

                Just "" ->
                    div [ class "dg-inbox-reading-body is-empty" ] [ text "No additional notes." ]

                Just textBody ->
                    markdownView "dg-inbox-reading-body" textBody item
        ]


{-| For an Item imported from email, a way back to the message in Apple Mail.
-}
mailButton : InboxItem -> List (Html Msg)
mailButton item =
    case item.messageId of
        Just _ ->
            [ button [ class "dg-mail-open", onClick (Send IgnoreReply (Command.OpenMail item.id)) ] [ text "✉ Open in Mail" ] ]

        Nothing ->
            []


itemMeta : InboxItem -> String
itemMeta item =
    item.created
        ++ (if String.isEmpty item.createdTime then
                ""

            else
                " " ++ item.createdTime
           )
        ++ (if item.legacyAction then
                " · Legacy Inbox Action"

            else
                ""
           )


chordLabel : String
chordLabel =
    "⌘/Ctrl"


processorView : Model -> Html Msg
processorView model =
    case currentItem model of
        Nothing ->
            emptyInbox model

        Just item ->
            let
                processed =
                    max 0 (model.sessionTotal - List.length model.snapshot.inboxItems)

                decision =
                    disposition model

                busy =
                    Set.member item.id (busyItems model)

                -- The GitHub pull request the Item links, once its text has loaded.
                pullRequest =
                    model.body
                        |> Maybe.andThen
                            (\loaded ->
                                if loaded.itemId == item.id then
                                    loaded.pullRequest

                                else
                                    Nothing
                            )

                progress =
                    if model.sessionTotal == 0 then
                        0

                    else
                        toFloat processed / toFloat model.sessionTotal * 100
            in
            div [ class "dg-processor", onProcessorChord, Ui.onModEnter (ProcessorChord ProcessChord) ]
                [ div [ class "dg-workflow-progress" ]
                    [ span [] [ text (String.fromInt processed ++ " / " ++ String.fromInt model.sessionTotal ++ " processed") ]
                    , if model.projectIssues > 0 then
                        -- Processing may give a stuck Project its next step; this shows which are.
                        button [ class "dg-flat-button dg-inbox-project-issues", onClick (Send IgnoreReply Command.ShowProjectIssues) ]
                            [ text ("⚑ " ++ Ui.plural model.projectIssues "Project issue") ]

                      else
                        text ""
                    , span [ classList [ ( "is-overdue", model.seconds == 0 ) ] ] [ text (Ui.timer model.seconds) ]
                    ]
                , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
                , itemCard model item
                , processingForm model
                , section [ class "dg-processor-action" ]
                    [ p [ class "dg-processor-outcome", attribute "aria-live" "polite" ]
                        [ span [] [ text "Outcome" ], strong [] [ text decision.label ] ]
                    , div [ class "dg-processor-buttons" ]
                        [ button
                            [ class "mod-warning"

                            , Html.Attributes.disabled busy
                            , onClick (DeleteItem item.id)
                            ]
                            [ text "Delete & Next" ]
                        , Ui.maybeView pullRequest
                            (\label ->
                                button [ Html.Attributes.disabled busy, onClick (ReviewPullRequest item.id) ]
                                    [ text ("+ Review " ++ label) ]
                            )
                        , button
                            [ class "mod-cta"

                            , Html.Attributes.disabled (not decision.ready || busy)
                            , onClick ProcessItem
                            ]
                            [ text "Process" ]
                        ]
                    ]
                , if model.seconds == 0 then
                    div [ class "dg-warning" ] [ text "Two minutes elapsed. Make the smallest clear decision and keep moving." ]

                  else
                    text ""
                ]


itemCard : Model -> InboxItem -> Html Msg
itemCard model item =
    let
        body =
            case model.body of
                Just loaded ->
                    if loaded.itemId == item.id then
                        loaded.text

                    else
                        ""

                Nothing ->
                    ""
    in
    section [ class "dg-processor-card" ]
        [ div [ class "dg-processor-heading" ]
            [ div [] [ h3 [] [ text item.title ], span [] [ text (itemMeta item) ] ]
            , div [ class "dg-processor-heading-actions" ]
                (mailButton item
                    ++ [ button [ onClick (Send IgnoreReply (Command.OpenFile item.file.path)) ]
                            [ text
                                (if item.file.extension == "md" then
                                    "Open note"

                                 else
                                    "Open file"
                                )
                            ]
                       ]
                )
            ]
        , if isAudio item.file.extension then
            audio [ class "dg-inbox-audio", controls True, preload "metadata", src item.resourceUrl ] []

          else if String.isEmpty body then
            div [ class "dg-inbox-preview is-empty" ] [ text "No additional notes." ]

          else
            markdownView "dg-inbox-preview" body item
        , label [ class "dg-processing-toggle dg-inbox-file-toggle" ]
            [ span [] [ text "Keep as reference" ]
            , input [ type_ "checkbox", checked model.fileOriginal, onCheck SetFileOriginal ] []
            , small [] [ text (fileOriginalHint model item) ]
            ]
        ]


processingForm : Model -> Html Msg
processingForm model =
    section [ class "dg-processing-form" ]
        [ div [ class "dg-processing-grid" ]
            ([ processingField True
                "Project"
                "Optional. Select an existing Project, or type a new name or “Parent > New sub-project”."
                [ Picker.view (projectPicker model) (projectSuggestions model) model.project
                , div [ class "dg-processing-toggles" ]
                    [ label [ class "dg-processing-inline-toggle" ]
                        [ input [ type_ "checkbox", checked model.backlog, onCheck SetBacklog ] [], span [] [ text "Backlog" ] ]
                    , label [ class "dg-processing-inline-toggle" ]
                        [ input [ type_ "checkbox", checked model.someday, onCheck SetSomeday ] [], span [] [ text "Someday/Maybe" ] ]
                    ]
                ]
            , processingField True
                "Project Vision"
                "Loaded from an existing Project when you choose it, and saved back if you change it. A new Project starts with it."
                [ textarea [ value model.desiredOutcome, placeholder "What will be true when this Project is complete?", onInput DesiredOutcomeChanged ] [] ]
            , processingField False
                "Action"
                (actionHint model.actionStatus)
                [ input [ id nextActionId, value model.nextAction, placeholder "What is the next physical Action?", onInput NextActionChanged ] [] ]
            , processingField False
                "Action status"
                "Choose Next, Waiting, or Calendar."
                [ Ui.labelled "Action status" (actionStatusSelect model.actionStatus) ]
            ]
                ++ (-- A Waiting Action is someone else's to move, so it has no context or energy.
                    if model.actionStatus == ActionStatus.Waiting then
                        []

                    else
                        [ div [ class "dg-processing-field" ]
                            [ div [ class "dg-processing-field-heading" ] [ span [] [ text "Context" ] ]
                            , Picker.view (contextPicker model) (contextSuggestions model) model.context
                            , small [] [ text "Required for this Action." ]
                            ]
                        , processingField False
                            "Energy"
                            "Optional. How much energy the Action takes."
                            [ energySelect model.energy ]
                        , processingField False
                            "Estimate"
                            "Optional. Roughly how long the Action takes."
                            [ estimateSelect model.estimate ]
                        ]
                   )
                ++ waitingFields model
                ++ scheduleFields model
            )
        ]


energySelect : Maybe Energy -> Html Msg
energySelect current =
    Ui.labelled "Energy"
        (select [ tabindex 0, onInput (Energy.fromKey >> EnergyChanged) ]
            (option [ value "", selected (current == Nothing) ] [ text "Normal" ]
                :: List.map
                    (\energy ->
                        option [ value (Energy.key energy), selected (current == Just energy) ]
                            [ text (Energy.symbol energy ++ " " ++ Energy.label energy) ]
                    )
                    Energy.all
            )
        )


estimateSelect : Maybe Int -> Html Msg
estimateSelect current =
    Ui.labelled "Estimate"
        (select [ tabindex 0, onInput (Estimate.fromKey >> EstimateChanged) ]
            (option [ value "", selected (current == Nothing) ] [ text "None" ]
                :: List.map
                    (\minutes -> option [ value (Estimate.key minutes), selected (current == Just minutes) ] [ text (Estimate.withSymbol minutes) ])
                    Estimate.all
            )
        )


processingField : Bool -> String -> String -> List (Html Msg) -> Html Msg
processingField wide name hint children =
    div [ classList [ ( "dg-processing-field", True ), ( "is-wide", wide ) ] ]
        (div [ class "dg-processing-field-heading" ] [ span [] [ text name ] ] :: children ++ [ small [] [ text hint ] ])


actionStatusSelect : ActionStatus -> Html Msg
actionStatusSelect current =
    -- An explicit tab stop: macOS keyboard navigation can leave pop-up menus out of Tab.
    select
        [ tabindex 0
        , value (ActionStatus.key current)
        , onInput
            (\raw ->
                [ ActionStatus.Next, ActionStatus.Waiting, ActionStatus.Scheduled ]
                    |> List.filter (\status -> ActionStatus.key status == raw)
                    |> List.head
                    |> Maybe.map ActionStatusChanged
                    |> Maybe.withDefault (ActionStatusChanged ActionStatus.Next)
            )
        ]
        (List.map
            (\status -> option [ value (ActionStatus.key status), selected (status == current) ] [ text (ActionStatus.label status) ])
            [ ActionStatus.Next, ActionStatus.Waiting, ActionStatus.Scheduled ]
        )


actionHint : ActionStatus -> String
actionHint status =
    case status of
        ActionStatus.Waiting ->
            "A Waiting Action can omit a context."

        ActionStatus.Scheduled ->
            "Choose when this Action belongs on the calendar."

        _ ->
            "Required with a context for Action-producing dispositions."


waitingFields : Model -> List (Html Msg)
waitingFields model =
    if model.actionStatus == ActionStatus.Waiting then
        [ processingField False
            "Waiting since"
            "The day this Action started waiting."
            [ Ui.labelled "Waiting since" (input [ type_ "date", value model.waitingSince, onInput WaitingSinceChanged ] []) ]
        , processingField False
            "Follow up"
            "Optional. From this day the Action is marked for chasing up."
            [ Ui.labelled "Follow up" (input [ type_ "date", value model.followUp, onInput FollowUpChanged ] []) ]
        ]

    else
        []


scheduleFields : Model -> List (Html Msg)
scheduleFields model =
    if model.actionStatus /= ActionStatus.Scheduled then
        []

    else
        [ processingField False
            "All day"
            "Reserve the whole day instead of a time of day."
            [ label [ class "dg-processing-inline-toggle" ]
                [ input [ type_ "checkbox", checked model.schedule.allDay, onCheck SetAllDay ] []
                , span [] [ text "All day" ]
                ]
            ]
        , processingField False
            (if model.schedule.allDay then "Date" else "Date & time")
            (if model.schedule.allDay then "Must happen on this day, at any time." else "Must happen at this local date and time.")
            [ Ui.labelled (if model.schedule.allDay then "Date" else "Date & time")
                (input
                    [ type_ (if model.schedule.allDay then "date" else "datetime-local")
                    , value model.schedule.start
                    , onInput ScheduledStartChanged
                    ]
                    []
                )
            ]
        ]
            ++ (if model.schedule.allDay then
                    []

                else
                    [ processingField False
                        "Duration"
                        "Minutes reserved on the calendar."
                        [ Ui.labelled "Duration" (input [ type_ "number", Html.Attributes.min "1", value model.schedule.duration, onInput ScheduledDurationChanged ] []) ]
                    ]
               )


projectPicker : Model -> Picker.Config Project Msg
projectPicker model =
    Picker.config
        { placeholder = "Search or name a Project…"
        , label = Hierarchy.breadcrumb model.snapshot.projects
        , hint = Hierarchy.area model.snapshot.projects
        , tag = ProjectPicker
        }


contextPicker : Model -> Picker.Config String Msg
contextPicker _ =
    Picker.config
        { placeholder = "Search or name a context…"
        , label = identity
        , hint = always Nothing
        , tag = ContextPicker
        }


projectSuggestions : Model -> List Project
projectSuggestions model =
    if String.isEmpty (Picker.query model.project) then
        []

    else
        model.snapshot.projects
            |> List.filter
                (\project ->
                    Ui.matches model.project.query
                        [ project.title
                        , Hierarchy.breadcrumb model.snapshot.projects project
                        , Maybe.withDefault "" (Hierarchy.area model.snapshot.projects project)
                        ]
                )
            |> List.sortBy (Hierarchy.breadcrumb model.snapshot.projects)
            |> List.take 8


contextSuggestions : Model -> List String
contextSuggestions model =
    if String.isEmpty (Picker.query model.context) then
        []

    else
        Data.contexts model.snapshot.actions
            |> List.filter (\candidate -> Ui.matches model.context.query [ candidate ])
            |> List.take 8



-- DISPOSITION


type alias Decision =
    { operation : Disposition, label : String, ready : Bool }


{-| The single primary button, and whether the form has said enough to press it.
-}
disposition : Model -> Decision
disposition model =
    let
        action =
            String.trim model.nextAction

        context =
            Picker.query model.context

        project =
            selectedProject model

        projectName =
            project
                |> Maybe.map .title
                |> Maybe.withDefault (Hierarchy.leafTitle model.project.query model.snapshot.projects)

        actionSuffix =
            if String.isEmpty action then
                ""

            else
                " + " ++ actionLabel model.actionStatus

        optionalReady =
            String.isEmpty action || actionIsReady model
    in
    if model.backlog then
        { operation = ParkAsBacklog
        , label =
            (case project of
                Just found ->
                    "Move " ++ found.title ++ " to Backlog"

                Nothing ->
                    "Create Backlog Project"
            )
                ++ actionSuffix
        , ready = optionalReady
        }

    else if model.someday then
        { operation = ParkAsSomeday
        , label =
            (case project of
                Just found ->
                    "Move " ++ found.title ++ " to Someday/Maybe"

                Nothing ->
                    "Create Someday/Maybe Project"
            )
                ++ actionSuffix
        , ready = optionalReady
        }

    else if model.fileOriginal then
        { operation = FileAsReference
        , label =
            (if String.isEmpty projectName then
                "File as General Reference"

             else
                "File with " ++ projectName
            )
                ++ actionSuffix
        , ready = optionalReady
        }

    else
        { operation = CreateNextAction
        , label =
            if String.isEmpty projectName then
                "Create " ++ actionLabel model.actionStatus

            else if project /= Nothing then
                "Create " ++ actionLabel model.actionStatus ++ " in " ++ projectName

            else
                "Create Project + " ++ actionLabel model.actionStatus
        , ready = not (String.isEmpty action) && actionIsReady model
        }


actionLabel : ActionStatus -> String
actionLabel status =
    case status of
        ActionStatus.Waiting ->
            "Waiting Action"

        ActionStatus.Scheduled ->
            "Calendar Action"

        _ ->
            "Next Action"


actionIsReady : Model -> Bool
actionIsReady model =
    let
        hasContext =
            not (ActionStatus.requiresContext model.actionStatus) || not (String.isEmpty (Picker.query model.context))

        scheduleReady =
            if model.actionStatus /= ActionStatus.Scheduled then
                True

            else if model.schedule.allDay then
                String.length model.schedule.start == 10

            else
                String.length model.schedule.start >= 16
                    && (String.toInt (String.trim model.schedule.duration)
                            |> Maybe.map (\minutes -> minutes > 0)
                            |> Maybe.withDefault False
                       )
    in
    hasContext && scheduleReady


processingInput : Model -> Command.InboxInput
processingInput model =
    { projectId = Maybe.map .id (Picker.selection model.project)
    , projectTitle = Picker.query model.project
    , desiredOutcome = String.trim model.desiredOutcome
    , nextAction = String.trim model.nextAction
    , status = model.actionStatus
    , context =
        if model.actionStatus == ActionStatus.Waiting then
            ""

        else
            Picker.query model.context
    , waitingSince = model.waitingSince
    , followUp = model.followUp
    , energy =
        if model.actionStatus == ActionStatus.Waiting then
            Nothing

        else
            model.energy
    , estimate =
        if model.actionStatus == ActionStatus.Waiting then
            Nothing

        else
            model.estimate
    , schedule = processingSchedule model
    , fileOriginal = model.fileOriginal
    }


processingSchedule : Model -> Maybe ScheduleInput
processingSchedule model =
    if model.actionStatus /= ActionStatus.Scheduled || String.isEmpty (String.trim model.nextAction) then
        Nothing

    else if model.schedule.allDay then
        Just (AllDayOn model.schedule.start)

    else
        String.toInt (String.trim model.schedule.duration)
            |> Maybe.map (TimedAt (String.left 16 model.schedule.start))


{-| The chosen Project, or the one an exactly typed title or breadcrumb names.
-}
selectedProject : Model -> Maybe Project
selectedProject model =
    case Picker.selection model.project of
        Just project ->
            Just project

        Nothing ->
            let
                typed =
                    String.toLower (Picker.query model.project)
            in
            if String.isEmpty typed then
                Nothing

            else
                model.snapshot.projects
                    |> List.filter
                        (\project ->
                            String.toLower project.title
                                == typed
                                || String.toLower (Hierarchy.breadcrumb model.snapshot.projects project)
                                == typed
                        )
                    |> List.head


fileOriginalHint : Model -> InboxItem -> String
fileOriginalHint model item =
    let
        -- Reference filed with a Project is its support material; without one it is General Reference.
        destination =
            case ( String.trim (Picker.query model.project), model.someday || model.backlog ) of
                ( "", True ) ->
                    -- Parking without a Project names a new one after this Item.
                    "Files it with the new Project's support material"

                ( "", False ) ->
                    "Files it in General Reference"

                ( name, _ ) ->
                    "Files it with " ++ name ++ "'s support material"

        capture =
            if item.file.extension == "md" then
                "note"

            else
                "file"
    in
    if model.someday || model.backlog then
        destination ++ ". Otherwise the " ++ capture ++ " goes to Obsidian's trash once the Project exists."

    else if item.file.extension == "md" then
        destination ++ " and creates a separate Action. Otherwise the note itself becomes the Action."

    else
        destination ++ ". Otherwise the file goes to Obsidian's trash once processed."



-- QUERIES


currentItem : Model -> Maybe InboxItem
currentItem model =
    let
        items =
            sortedItems model.snapshot.inboxItems

        count =
            List.length items
    in
    if count == 0 then
        Nothing

    else
        List.drop (modBy count model.cursor) items |> List.head


sortedItems : List InboxItem -> List InboxItem
sortedItems =
    List.sortBy (\item -> ( item.created, item.id ))


indexOf : InboxItemId -> List InboxItem -> Maybe Int
indexOf wanted items =
    items
        |> List.indexedMap Tuple.pair
        |> List.filter (\( _, item ) -> item.id == wanted)
        |> List.head
        |> Maybe.map Tuple.first


isAudio : String -> Bool
isAudio extension =
    List.member (String.toLower extension)
        [ "3gp", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm" ]



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map3 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "initialProcessing" Decode.bool)
        (Decode.oneOf [ Decode.field "projectIssues" Decode.int, Decode.succeed 0 ])


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "start-processing" ->
                        Decode.map StartProcessingEvent (Decode.maybe (Decode.field "itemId" Decode.string))

                    "project-issues" ->
                        Decode.map ProjectIssuesEvent (Decode.field "count" Decode.int)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
