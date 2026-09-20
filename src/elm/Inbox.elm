port module Inbox exposing (main)

import Browser
import Gtd.Command as Command exposing (Command, Disposition(..))
import Gtd.Data as Data exposing (InboxItem, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (InboxItemId)
import Gtd.Picker as Picker exposing (Picker)
import Gtd.Ui as Ui
import Html exposing (Html, article, audio, button, div, h2, h3, header, input, label, p, section, small, span, text, textarea)
import Html.Attributes exposing (attribute, checked, class, classList, controls, placeholder, preload, src, style, title, type_, value)
import Html.Events exposing (onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
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
    | Working InboxItemId


type alias Model =
    { snapshot : Snapshot
    , search : String
    , processing : Bool
    , cursor : Int
    , sessionTotal : Int
    , seconds : Int
    , body : Maybe { itemId : InboxItemId, text : String }
    , project : Picker Project
    , context : Picker String
    , desiredOutcome : String
    , nextAction : String
    , work : Bool
    , someday : Bool
    , fileOriginal : Bool
    , requests : Requests Pending
    , error : Maybe String
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
    | SetWork Bool
    | SetSomeday Bool
    | SetFileOriginal Bool
    | DeleteItem InboxItemId
    | ProcessItem
    | Send Pending Command


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot, initialProcessing : Bool }


init : Decode.Value -> ( Model, Cmd Msg )
init flagsValue =
    case Decode.decodeValue flagsDecoder flagsValue of
        Ok flags ->
            let
                model =
                    initialModel flags.snapshot
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
    , search = ""
    , processing = False
    , cursor = 0
    , sessionTotal = 0
    , seconds = decisionSeconds
    , body = Nothing
    , project = Picker.init "" Nothing
    , context = Picker.init "" Nothing
    , desiredOutcome = ""
    , nextAction = ""
    , work = False
    , someday = False
    , fileOriginal = False
    , requests = Host.noRequests
    , error = Nothing
    }


blank : Model
blank =
    initialModel Data.empty


subscriptions : Model -> Sub Msg
subscriptions model =
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
            ( { model
                | project =
                    Picker.update pickerMsg (projectSuggestions model) (Hierarchy.breadcrumb model.snapshot.projects) model.project
              }
            , Cmd.none
            )

        ContextPicker pickerMsg ->
            ( { model | context = Picker.update pickerMsg (contextSuggestions model) identity model.context }, Cmd.none )

        DesiredOutcomeChanged desiredOutcome ->
            ( { model | desiredOutcome = desiredOutcome }, Cmd.none )

        NextActionChanged nextAction ->
            ( { model | nextAction = nextAction }, Cmd.none )

        SetWork work ->
            ( { model | work = work }, Cmd.none )

        SetSomeday someday ->
            ( { model | someday = someday }, Cmd.none )

        SetFileOriginal fileOriginal ->
            ( { model | fileOriginal = fileOriginal }, Cmd.none )

        DeleteItem itemId ->
            sendForItem itemId (Command.TrashInboxItem itemId) model

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

                    else
                        sendForItem item.id (Command.ProcessInbox item.id decision.operation (processingInput model)) model

        Send pending command ->
            send pending command model


enterProcessing : Maybe InboxItemId -> Model -> ( Model, Cmd Msg )
enterProcessing maybeId model =
    let
        items =
            sortedItems model.snapshot.inboxItems

        cursor =
            maybeId
                |> Maybe.andThen (\wanted -> indexOf wanted items)
                |> Maybe.withDefault 0
    in
    resetCurrent { model | processing = True, cursor = cursor, sessionTotal = List.length items }


resetCurrent : Model -> ( Model, Cmd Msg )
resetCurrent model =
    case currentItem model of
        Nothing ->
            ( { model | body = Nothing }, Cmd.none )

        Just item ->
            let
                prefill =
                    String.left 50 item.title
            in
            send (LoadBody item.id)
                (Command.ReadInboxBody item.id)
                { model
                    | seconds = decisionSeconds
                    , body = Nothing
                    , project = Picker.init prefill Nothing
                    , context = Picker.init "" Nothing
                    , desiredOutcome = ""
                    , nextAction = prefill
                    , work = False
                    , someday = False
                    , fileOriginal = False
                    , error = Nothing
                }


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests }, inboxToHost (Host.envelope requestId (Command.encode command)) )


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
    | StartProcessingEvent
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            let
                previousId =
                    currentItem model |> Maybe.map .id

                next =
                    { model | snapshot = snapshot }

                nextId =
                    currentItem next |> Maybe.map .id
            in
            if model.processing && previousId /= nextId then
                resetCurrent next

            else
                ( next, Cmd.none )

        Ok StartProcessingEvent ->
            if model.processing then
                ( model, Cmd.none )

            else
                enterProcessing Nothing model

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests }
            in
            case ( outcome.result, Maybe.withDefault IgnoreReply pending ) of
                ( Err message, _ ) ->
                    ( { next | error = Just message }, Cmd.none )

                ( Ok resultValue, LoadBody itemId ) ->
                    if (currentItem model |> Maybe.map .id) == Just itemId then
                        ( { next | body = Just { itemId = itemId, text = decodedString resultValue } }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Ok _, _ ) ->
                    ( { next | error = Nothing }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )


decodedString : Decode.Value -> String
decodedString value =
    Decode.decodeValue Decode.string value |> Result.withDefault ""



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
                    button [ onClick ShowList ] [ text "List" ]

                  else
                    button [ Html.Attributes.disabled (List.isEmpty model.snapshot.inboxItems), onClick (StartProcessing Nothing) ] [ text "Process Inbox" ]
                , button [ class "mod-cta", onClick (Send IgnoreReply Command.QuickCapture) ] [ text "Capture" ]
                ]
            ]
        , Ui.issuesView model.snapshot.issues
        , Ui.maybeView model.error (\message -> div [ class "dg-warning" ] [ text message ])
        , if model.processing then
            processorView model

          else
            listView model
        ]


listView : Model -> Html Msg
listView model =
    let
        items =
            sortedItems model.snapshot.inboxItems
                |> List.filter (\item -> Ui.matches model.search [ item.title ])
    in
    div []
        [ div [ class "dg-toolbar dg-inbox-toolbar" ]
            [ input [ type_ "search", placeholder "Search Inbox", value model.search, onInput SearchChanged ] [] ]
        , div [ class "dg-inbox-list", attribute "role" "list", attribute "aria-label" "Inbox Items" ]
            (if List.isEmpty items then
                [ div [ class "dg-empty-row" ]
                    [ text
                        (if String.isEmpty model.search then
                            "Inbox zero."

                         else
                            "No Inbox Items match this search."
                        )
                    ]
                ]

             else
                List.map (inboxRow (busyItems model)) items
            )
        ]


inboxRow : Set InboxItemId -> InboxItem -> Html Msg
inboxRow busy item =
    article [ class "dg-inbox-row", attribute "role" "listitem" ]
        [ div [ class "dg-inbox-item-main" ]
            [ button [ class "dg-project-title", onClick (Send IgnoreReply (Command.OpenFile item.file.path)) ] [ text item.title ]
            , span [ class "dg-inbox-meta" ] [ text (itemMeta item) ]
            ]
        , div [ class "dg-inbox-row-actions" ]
            [ button [ class "mod-cta", Html.Attributes.disabled (Set.member item.id busy), onClick (StartProcessing (Just item.id)) ] [ text "Process" ]
            , button [ class "mod-warning", Html.Attributes.disabled (Set.member item.id busy), onClick (DeleteItem item.id) ] [ text "Delete" ]
            ]
        ]


itemMeta : InboxItem -> String
itemMeta item =
    item.created
        ++ (if item.legacyAction then
                " · Legacy Inbox Action"

            else
                ""
           )


processorView : Model -> Html Msg
processorView model =
    case currentItem model of
        Nothing ->
            div [ class "dg-workflow-complete" ]
                [ span [] [ text "🎉" ], h3 [] [ text "Inbox zero" ], p [] [ text "Everything captured has been clarified." ] ]

        Just item ->
            let
                processed =
                    max 0 (model.sessionTotal - List.length model.snapshot.inboxItems)

                decision =
                    disposition model

                busy =
                    Set.member item.id (busyItems model)

                progress =
                    if model.sessionTotal == 0 then
                        0

                    else
                        toFloat processed / toFloat model.sessionTotal * 100
            in
            div [ class "dg-processor" ]
                [ div [ class "dg-workflow-progress" ]
                    [ span [] [ text (String.fromInt processed ++ " / " ++ String.fromInt model.sessionTotal ++ " processed") ]
                    , span [ classList [ ( "is-overdue", model.seconds == 0 ) ] ] [ text (Ui.timer model.seconds) ]
                    ]
                , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
                , itemCard model item
                , section [ class "dg-processor-action" ]
                    [ button [ class "mod-warning", Html.Attributes.disabled busy, onClick (DeleteItem item.id) ] [ text "Delete & Next" ] ]
                , processingForm model
                , section [ class "dg-processor-action" ]
                    [ button
                        [ class "mod-cta"
                        , title decision.label
                        , Html.Attributes.disabled (not decision.ready || busy)
                        , onClick ProcessItem
                        ]
                        [ text decision.label ]
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
            , button [ onClick (Send IgnoreReply (Command.OpenFile item.file.path)) ]
                [ text
                    (if item.file.extension == "md" then
                        "Open note"

                     else
                        "Open file"
                    )
                ]
            ]
        , if isAudio item.file.extension then
            audio [ class "dg-inbox-audio", controls True, preload "metadata", src item.resourceUrl ] []

          else
            div [ classList [ ( "dg-inbox-preview", True ), ( "is-empty", String.isEmpty body ) ] ]
                [ text
                    (if String.isEmpty body then
                        "No additional notes."

                     else
                        body
                    )
                ]
        , label [ class "dg-processing-toggle dg-inbox-file-toggle" ]
            [ span [] [ text "File with Project" ]
            , input [ type_ "checkbox", checked model.fileOriginal, onCheck SetFileOriginal ] []
            , small [] [ text (fileOriginalHint model item) ]
            ]
        ]


processingForm : Model -> Html Msg
processingForm model =
    section [ class "dg-processing-form", attribute "aria-label" "Clarify Inbox Item" ]
        [ div [ class "dg-processing-grid" ]
            [ processingField True
                "Project"
                "Optional. Select an existing Project, or type a new name or “Parent > New sub-project”."
                [ Picker.view (projectPicker model) (projectSuggestions model) model.project
                , label [ class "dg-processing-inline-toggle", title "Parks the Project instead of activating it." ]
                    [ input [ type_ "checkbox", checked model.someday, onCheck SetSomeday ] [], span [] [ text "Someday/Maybe" ] ]
                ]
            , processingField True
                "Project Vision"
                "Applied when a Project is selected or created."
                [ textarea [ value model.desiredOutcome, placeholder "What will be true when this Project is complete?", onInput DesiredOutcomeChanged ] [] ]
            , processingField False
                "Next Action"
                "Required with a context for Action-producing dispositions."
                [ input [ value model.nextAction, placeholder "What is the next physical Action?", onInput NextActionChanged ] [] ]
            , div [ class "dg-processing-field" ]
                [ div [ class "dg-processing-field-heading" ]
                    [ span [] [ text "Context" ]
                    , label [ class "dg-processing-inline-toggle", title "Marks the Action as work, independent of its context." ]
                        [ input [ type_ "checkbox", checked model.work, onCheck SetWork ] [], span [] [ text "Work" ] ]
                    ]
                , Picker.view (contextPicker model) (contextSuggestions model) model.context
                , small [] [ text "Required when creating a Next Action." ]
                ]
            ]
        ]


processingField : Bool -> String -> String -> List (Html Msg) -> Html Msg
processingField wide name hint children =
    div [ classList [ ( "dg-processing-field", True ), ( "is-wide", wide ) ] ]
        (div [ class "dg-processing-field-heading" ] [ span [] [ text name ] ] :: children ++ [ small [] [ text hint ] ])


projectPicker : Model -> Picker.Config Project Msg
projectPicker model =
    Picker.config
        { placeholder = "Search or name a Project…"
        , label = Hierarchy.breadcrumb model.snapshot.projects
        , hint = .area
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
                        , Maybe.withDefault "" project.area
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
                " + Next Action"

        optionalReady =
            String.isEmpty action || not (String.isEmpty context)
    in
    if model.someday then
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
                "Create Next Action"

            else if project /= Nothing then
                "Create Next Action in " ++ projectName

            else
                "Create Project + Next Action"
        , ready = not (String.isEmpty action) && not (String.isEmpty context)
        }


processingInput : Model -> Command.InboxInput
processingInput model =
    { projectId = Maybe.map .id (Picker.selection model.project)
    , projectTitle = Picker.query model.project
    , desiredOutcome = String.trim model.desiredOutcome
    , nextAction = String.trim model.nextAction
    , context = Picker.query model.context
    , work = model.work
    , fileOriginal = model.fileOriginal
    }


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
    if model.someday then
        "Keeps this capture as Project support material. Otherwise it goes to Obsidian's trash once the Project exists."

    else if item.file.extension == "md" then
        "Keeps this note as reference and creates a separate Action. Otherwise the note itself becomes the Action."

    else
        "Keeps this file as support material, or in General Reference with no Project. Otherwise it goes to Obsidian's trash once processed."



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
    Decode.map2 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "initialProcessing" Decode.bool)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "start-processing" ->
                        Decode.succeed StartProcessingEvent

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
