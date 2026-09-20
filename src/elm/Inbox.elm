port module Inbox exposing (main)

import Browser
import Dict exposing (Dict)
import Html exposing (Html, article, audio, button, div, h2, h3, header, input, label, option, p, section, select, small, span, text, textarea)
import Html.Attributes exposing (attribute, checked, class, classList, controls, disabled, placeholder, preload, selected, src, style, title, type_, value)
import Html.Events exposing (custom, onBlur, onCheck, onClick, onFocus, onInput, onMouseEnter)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Time


port inboxToHost : Encode.Value -> Cmd msg


port inboxFromHost : (Decode.Value -> msg) -> Sub msg


protocolVersion : Int
protocolVersion =
    1


type alias File =
    { path : String, extension : String }


type alias InboxItem =
    { id : String
    , title : String
    , created : String
    , file : File
    , resourceUrl : String
    , legacyAction : Bool
    }


type alias Action =
    { context : Maybe String }


type alias Project =
    { id : String
    , title : String
    , status : String
    , area : Maybe String
    , parentProjectId : Maybe String
    }


type alias Issue =
    { path : String, message : String }


type alias Snapshot =
    { revision : Int
    , inboxItems : List InboxItem
    , actions : List Action
    , projects : List Project
    , issues : List Issue
    }


type alias Flags =
    { snapshot : Snapshot, initialProcessing : Bool }


type alias Model =
    { snapshot : Snapshot
    , search : String
    , processing : Bool
    , cursor : Int
    , sessionTotal : Int
    , seconds : Int
    , body : String
    , bodyFor : Maybe String
    , projectQuery : String
    , projectId : String
    , desiredOutcome : String
    , nextAction : String
    , context : String
    , work : Bool
    , someday : Bool
    , fileOriginal : Bool
    , projectSuggestionsOpen : Bool
    , contextSuggestionsOpen : Bool
    , projectActiveIndex : Int
    , contextActiveIndex : Int
    , busyItems : Set String
    , bodyRequests : Dict String String
    , nextRequest : Int
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | SearchChanged String
    | StartProcessing (Maybe String)
    | ShowList
    | ProjectChanged String
    | ChooseProject String String
    | SetProjectSuggestions Bool
    | ProjectKey String
    | HoverProject Int
    | DesiredOutcomeChanged String
    | NextActionChanged String
    | ContextChanged String
    | ChooseContext String
    | SetContextSuggestions Bool
    | ContextKey String
    | HoverContext Int
    | SetWork Bool
    | SetSomeday Bool
    | SetFileOriginal Bool
    | DeleteItem String
    | ProcessItem
    | OpenFile String
    | Capture


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flagsValue =
    case Decode.decodeValue flagsDecoder flagsValue of
        Ok flags ->
            let
                model =
                    initialModel flags
            in
            if flags.initialProcessing && not (List.isEmpty flags.snapshot.inboxItems) then
                enterProcessing Nothing model

            else
                ( model, Cmd.none )

        Err error ->
            let
                fallback =
                    initialModel emptyFlags
            in
            ( { fallback | error = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Flags -> Model
initialModel flags =
    { snapshot = flags.snapshot
    , search = ""
    , processing = False
    , cursor = 0
    , sessionTotal = 0
    , seconds = 120
    , body = ""
    , bodyFor = Nothing
    , projectQuery = ""
    , projectId = ""
    , desiredOutcome = ""
    , nextAction = ""
    , context = ""
    , work = False
    , someday = False
    , fileOriginal = False
    , projectSuggestionsOpen = False
    , contextSuggestionsOpen = False
    , projectActiveIndex = 0
    , contextActiveIndex = 0
    , busyItems = Set.empty
    , bodyRequests = Dict.empty
    , nextRequest = 1
    , error = Nothing
    }


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
        GotHost value_ ->
            receiveHost value_ model

        Tick _ ->
            ( { model | seconds = max 0 (model.seconds - 1) }, Cmd.none )

        SearchChanged search ->
            ( { model | search = search }, Cmd.none )

        StartProcessing maybeId ->
            enterProcessing maybeId model

        ShowList ->
            ( { model | processing = False }, Cmd.none )

        ProjectChanged query ->
            ( { model | projectQuery = query, projectId = "", projectSuggestionsOpen = True, projectActiveIndex = 0 }, Cmd.none )

        ChooseProject projectId projectName ->
            ( { model | projectId = projectId, projectQuery = projectName, projectSuggestionsOpen = False }, Cmd.none )

        SetProjectSuggestions open ->
            ( { model | projectSuggestionsOpen = open }, Cmd.none )

        ProjectKey key ->
            projectKey key model

        HoverProject index_ ->
            ( { model | projectActiveIndex = index_ }, Cmd.none )

        DesiredOutcomeChanged desiredOutcome ->
            ( { model | desiredOutcome = desiredOutcome }, Cmd.none )

        NextActionChanged nextAction ->
            ( { model | nextAction = nextAction }, Cmd.none )

        ContextChanged context ->
            ( { model | context = context, contextSuggestionsOpen = True, contextActiveIndex = 0 }, Cmd.none )

        ChooseContext context ->
            ( { model | context = context, contextSuggestionsOpen = False }, Cmd.none )

        SetContextSuggestions open ->
            ( { model | contextSuggestionsOpen = open }, Cmd.none )

        ContextKey key ->
            contextKey key model

        HoverContext index_ ->
            ( { model | contextActiveIndex = index_ }, Cmd.none )

        SetWork work ->
            ( { model | work = work }, Cmd.none )

        SetSomeday someday ->
            ( { model | someday = someday }, Cmd.none )

        SetFileOriginal fileOriginal ->
            ( { model | fileOriginal = fileOriginal }, Cmd.none )

        DeleteItem itemId ->
            sendBusy itemId (Encode.object [ ( "type", Encode.string "trash-inbox-item" ), ( "itemId", Encode.string itemId ) ]) model

        ProcessItem ->
            case currentItem model of
                Nothing ->
                    ( model, Cmd.none )

                Just item ->
                    let
                        disposition =
                            primaryDisposition model
                    in
                    if not disposition.ready then
                        ( model, Cmd.none )

                    else
                        sendBusy item.id (processCommand item.id disposition.operation model) model

        OpenFile path ->
            sendSimple (Encode.object [ ( "type", Encode.string "open-file" ), ( "path", Encode.string path ) ]) model

        Capture ->
            sendSimple (Encode.object [ ( "type", Encode.string "quick-capture" ) ]) model


enterProcessing : Maybe String -> Model -> ( Model, Cmd Msg )
enterProcessing maybeId model =
    let
        items =
            sortedItems model.snapshot.inboxItems

        cursor =
            maybeId
                |> Maybe.andThen (\wanted -> indexOf wanted items)
                |> Maybe.withDefault 0

        processingModel =
            { model | processing = True, cursor = cursor, sessionTotal = List.length items }
    in
    resetCurrent processingModel


resetCurrent : Model -> ( Model, Cmd Msg )
resetCurrent model =
    case currentItem model of
        Nothing ->
            ( { model | body = "", bodyFor = Nothing }, Cmd.none )

        Just item ->
            let
                prefill =
                    String.left 50 item.title

                reset =
                    { model
                        | seconds = 120
                        , body = ""
                        , bodyFor = Nothing
                        , projectQuery = prefill
                        , projectId = ""
                        , desiredOutcome = ""
                        , nextAction = prefill
                        , context = ""
                        , work = False
                        , someday = False
                        , fileOriginal = False
                        , projectSuggestionsOpen = False
                        , contextSuggestionsOpen = False
                        , projectActiveIndex = 0
                        , contextActiveIndex = 0
                        , error = Nothing
                    }
            in
            requestBody item reset


requestBody : InboxItem -> Model -> ( Model, Cmd Msg )
requestBody item model =
    let
        requestId =
            requestIdFor model

        command =
            Encode.object [ ( "type", Encode.string "read-inbox-body" ), ( "itemId", Encode.string item.id ) ]
    in
    ( { model | nextRequest = model.nextRequest + 1, bodyRequests = Dict.insert requestId item.id model.bodyRequests }
    , inboxToHost (envelope requestId command)
    )


sendBusy : String -> Encode.Value -> Model -> ( Model, Cmd Msg )
sendBusy itemId command model =
    if Set.member itemId model.busyItems then
        ( model, Cmd.none )

    else
        let
            requestId =
                requestIdFor model
        in
        ( { model | nextRequest = model.nextRequest + 1, busyItems = Set.insert itemId model.busyItems }
        , inboxToHost (envelope requestId command)
        )


sendSimple : Encode.Value -> Model -> ( Model, Cmd Msg )
sendSimple command model =
    let
        requestId =
            requestIdFor model
    in
    ( { model | nextRequest = model.nextRequest + 1 }, inboxToHost (envelope requestId command) )


projectKey : String -> Model -> ( Model, Cmd Msg )
projectKey key model =
    let
        suggestions =
            projectSuggestions model

        count =
            List.length suggestions
    in
    case key of
        "Escape" ->
            ( { model | projectSuggestionsOpen = False }, Cmd.none )

        "ArrowDown" ->
            ( { model | projectSuggestionsOpen = True, projectActiveIndex = nextIndex 1 count model.projectActiveIndex }, Cmd.none )

        "ArrowUp" ->
            ( { model | projectSuggestionsOpen = True, projectActiveIndex = nextIndex -1 count model.projectActiveIndex }, Cmd.none )

        "Enter" ->
            if model.projectSuggestionsOpen then
                case List.drop model.projectActiveIndex suggestions |> List.head of
                    Just project ->
                        ( { model | projectId = project.id, projectQuery = projectBreadcrumb model.snapshot.projects project, projectSuggestionsOpen = False }, Cmd.none )

                    Nothing ->
                        ( model, Cmd.none )

            else
                ( model, Cmd.none )

        _ ->
            ( model, Cmd.none )


contextKey : String -> Model -> ( Model, Cmd Msg )
contextKey key model =
    let
        suggestions =
            contextSuggestions model

        count =
            List.length suggestions
    in
    case key of
        "Escape" ->
            ( { model | contextSuggestionsOpen = False }, Cmd.none )

        "ArrowDown" ->
            ( { model | contextSuggestionsOpen = True, contextActiveIndex = nextIndex 1 count model.contextActiveIndex }, Cmd.none )

        "ArrowUp" ->
            ( { model | contextSuggestionsOpen = True, contextActiveIndex = nextIndex -1 count model.contextActiveIndex }, Cmd.none )

        "Enter" ->
            if model.contextSuggestionsOpen then
                case List.drop model.contextActiveIndex suggestions |> List.head of
                    Just context ->
                        ( { model | context = context, contextSuggestionsOpen = False }, Cmd.none )

                    Nothing ->
                        ( model, Cmd.none )

            else
                ( model, Cmd.none )

        _ ->
            ( model, Cmd.none )


nextIndex : Int -> Int -> Int -> Int
nextIndex direction count current =
    if count == 0 then
        0

    else
        modBy count (current + direction)


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value_ model =
    case Decode.decodeValue hostEventDecoder value_ of
        Ok (SnapshotEvent snapshot) ->
            let
                previousId =
                    currentItem model |> Maybe.map .id

                remainingIds =
                    Set.fromList (List.map .id snapshot.inboxItems)

                nextModel =
                    { model | snapshot = snapshot, busyItems = Set.intersect model.busyItems remainingIds }

                nextId =
                    currentItem nextModel |> Maybe.map .id
            in
            if model.processing && previousId /= nextId then
                resetCurrent nextModel

            else
                ( nextModel, Cmd.none )

        Ok StartProcessingEvent ->
            if model.processing then
                ( model, Cmd.none )

            else
                enterProcessing Nothing model

        Ok (CommandResult requestId succeeded error resultValue) ->
            case Dict.get requestId model.bodyRequests of
                Just itemId ->
                    let
                        next =
                            { model | bodyRequests = Dict.remove requestId model.bodyRequests }
                    in
                    if succeeded && (currentItem model |> Maybe.map .id) == Just itemId then
                        ( { next | body = Maybe.withDefault "" resultValue, bodyFor = Just itemId }, Cmd.none )

                    else
                        ( next, Cmd.none )

                Nothing ->
                    if succeeded then
                        ( model, Cmd.none )

                    else
                        ( { model | busyItems = Set.empty, error = error }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )


type HostEvent
    = SnapshotEvent Snapshot
    | StartProcessingEvent
    | CommandResult String Bool (Maybe String) (Maybe String)


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
                    button [ disabled (List.isEmpty model.snapshot.inboxItems), onClick (StartProcessing Nothing) ] [ text "Process Inbox" ]
                , button [ class "mod-cta", onClick Capture ] [ text "Capture" ]
                ]
            ]
        , issuesView model.snapshot.issues
        , Maybe.map (\message -> div [ class "dg-warning" ] [ text message ]) model.error |> Maybe.withDefault (text "")
        , if model.processing then
            processorView model

          else
            listView model
        ]


issuesView : List Issue -> Html Msg
issuesView issues =
    if List.isEmpty issues then
        text ""

    else
        div
            [ class "dg-warning"
            , title (String.join "\n" (List.map (\problem -> problem.path ++ ": " ++ problem.message) issues))
            ]
            [ text (String.fromInt (List.length issues) ++ " GTD files have metadata problems.") ]


listView : Model -> Html Msg
listView model =
    let
        needle =
            String.toLower (String.trim model.search)

        items =
            sortedItems model.snapshot.inboxItems |> List.filter (\item -> String.isEmpty needle || String.contains needle (String.toLower item.title))
    in
    div []
        [ div [ class "dg-toolbar dg-inbox-toolbar" ] [ input [ type_ "search", placeholder "Search Inbox", value model.search, onInput SearchChanged ] [] ]
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
                List.map (inboxRow model) items
            )
        ]


inboxRow : Model -> InboxItem -> Html Msg
inboxRow model item =
    let
        busy =
            Set.member item.id model.busyItems
    in
    article [ class "dg-inbox-row", attribute "role" "listitem" ]
        [ div [ class "dg-inbox-item-main" ]
            [ button [ class "dg-project-title", onClick (OpenFile item.file.path) ] [ text item.title ]
            , span [ class "dg-inbox-meta" ]
                [ text
                    (item.created
                        ++ (if item.legacyAction then
                                " · Legacy Inbox Action"

                            else
                                ""
                           )
                    )
                ]
            ]
        , div [ class "dg-inbox-row-actions" ]
            [ button [ class "mod-cta", disabled busy, onClick (StartProcessing (Just item.id)) ] [ text "Process" ]
            , button [ class "mod-warning", disabled busy, onClick (DeleteItem item.id) ] [ text "Delete" ]
            ]
        ]


processorView : Model -> Html Msg
processorView model =
    case currentItem model of
        Nothing ->
            div [ class "dg-workflow-complete" ] [ span [] [ text "🎉" ], h3 [] [ text "Inbox zero" ], p [] [ text "Everything captured has been clarified." ] ]

        Just item ->
            let
                processed =
                    max 0 (model.sessionTotal - List.length model.snapshot.inboxItems)

                disposition =
                    primaryDisposition model

                busy =
                    Set.member item.id model.busyItems

                progress =
                    if model.sessionTotal == 0 then
                        0

                    else
                        toFloat processed / toFloat model.sessionTotal * 100
            in
            div [ class "dg-processor" ]
                [ div [ class "dg-workflow-progress" ]
                    [ span [] [ text (String.fromInt processed ++ " / " ++ String.fromInt model.sessionTotal ++ " processed") ]
                    , span [ classList [ ( "is-overdue", model.seconds == 0 ) ] ] [ text (formatTimer model.seconds) ]
                    ]
                , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
                , itemCard model item
                , section [ class "dg-processor-action" ] [ button [ class "mod-warning", disabled busy, onClick (DeleteItem item.id) ] [ text "Delete & Next" ] ]
                , processingForm model
                , section [ class "dg-processor-action" ]
                    [ button [ class "mod-cta", title disposition.label, disabled (not disposition.ready || busy), onClick ProcessItem ] [ text disposition.label ] ]
                , if model.seconds == 0 then
                    div [ class "dg-warning" ] [ text "Two minutes elapsed. Make the smallest clear decision and keep moving." ]

                  else
                    text ""
                ]


itemCard : Model -> InboxItem -> Html Msg
itemCard model item =
    section [ class "dg-processor-card" ]
        [ div [ class "dg-processor-heading" ]
            [ div []
                [ h3 [] [ text item.title ]
                , span []
                    [ text
                        (item.created
                            ++ (if item.legacyAction then
                                    " · Legacy Inbox Action"

                                else
                                    ""
                               )
                        )
                    ]
                ]
            , button [ onClick (OpenFile item.file.path) ]
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
            div [ classList [ ( "dg-inbox-preview", True ), ( "is-empty", String.isEmpty model.body ) ] ]
                [ text
                    (if String.isEmpty model.body then
                        "No additional notes."

                     else
                        model.body
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
                [ fuzzyProject model
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
                , fuzzyContext model
                , small [] [ text "Required when creating a Next Action." ]
                ]
            ]
        ]


processingField : Bool -> String -> String -> List (Html Msg) -> Html Msg
processingField wide name hint children =
    div [ classList [ ( "dg-processing-field", True ), ( "is-wide", wide ) ] ]
        (div [ class "dg-processing-field-heading" ] [ span [] [ text name ] ] :: children ++ [ small [] [ text hint ] ])


fuzzyProject : Model -> Html Msg
fuzzyProject model =
    let
        suggestions =
            projectSuggestions model
    in
    div [ class "dg-fuzzy-field" ]
        [ input [ value model.projectQuery, placeholder "Search or name a Project…", attribute "autocomplete" "off", onFocus (SetProjectSuggestions True), onBlur (SetProjectSuggestions False), onInput ProjectChanged, fuzzyKeydown model.projectSuggestionsOpen ProjectKey ] []
        , if not model.projectSuggestionsOpen || String.isEmpty (String.trim model.projectQuery) then
            text ""

          else
            div [ class "dg-fuzzy-results", attribute "role" "listbox" ]
                (List.indexedMap
                    (\index_ project ->
                        button
                            [ type_ "button"
                            , attribute "role" "option"
                            , attribute "aria-selected"
                                (if index_ == model.projectActiveIndex then
                                    "true"

                                 else
                                    "false"
                                )
                            , classList [ ( "is-active", index_ == model.projectActiveIndex ) ]
                            , onMouseEnter (HoverProject index_)
                            , preventMouseDown (ChooseProject project.id (projectBreadcrumb model.snapshot.projects project))
                            ]
                            [ span [] [ text (projectBreadcrumb model.snapshot.projects project) ], Maybe.map (\area -> small [] [ text area ]) project.area |> Maybe.withDefault (text "") ]
                    )
                    suggestions
                )
        ]


projectSuggestions : Model -> List Project
projectSuggestions model =
    model.snapshot.projects
        |> List.filter (\project -> fuzzyMatch model.projectQuery [ project.title, projectBreadcrumb model.snapshot.projects project, Maybe.withDefault "" project.area ])
        |> List.sortBy (projectBreadcrumb model.snapshot.projects)
        |> List.take 8


fuzzyContext : Model -> Html Msg
fuzzyContext model =
    let
        suggestions =
            contextSuggestions model
    in
    div [ class "dg-fuzzy-field" ]
        [ input [ value model.context, placeholder "Search or name a context…", attribute "autocomplete" "off", onFocus (SetContextSuggestions True), onBlur (SetContextSuggestions False), onInput ContextChanged, fuzzyKeydown model.contextSuggestionsOpen ContextKey ] []
        , if not model.contextSuggestionsOpen || String.isEmpty (String.trim model.context) then
            text ""

          else
            div [ class "dg-fuzzy-results", attribute "role" "listbox" ]
                (List.indexedMap
                    (\index_ candidate ->
                        button
                            [ type_ "button"
                            , attribute "role" "option"
                            , attribute "aria-selected"
                                (if index_ == model.contextActiveIndex then
                                    "true"

                                 else
                                    "false"
                                )
                            , classList [ ( "is-active", index_ == model.contextActiveIndex ) ]
                            , onMouseEnter (HoverContext index_)
                            , preventMouseDown (ChooseContext candidate)
                            ]
                            [ span [] [ text candidate ] ]
                    )
                    suggestions
                )
        ]


contextSuggestions : Model -> List String
contextSuggestions model =
    allContexts model.snapshot.actions |> List.filter (\candidate -> fuzzyMatch model.context [ candidate ]) |> List.take 8


preventMouseDown : msg -> Html.Attribute msg
preventMouseDown message =
    custom "mousedown" (Decode.succeed { message = message, stopPropagation = False, preventDefault = True })


fuzzyKeydown : Bool -> (String -> msg) -> Html.Attribute msg
fuzzyKeydown open toMessage =
    custom "keydown"
        (Decode.field "key" Decode.string
            |> Decode.map
                (\key ->
                    { message = toMessage key
                    , stopPropagation = False
                    , preventDefault = open && List.member key [ "ArrowDown", "ArrowUp", "Enter" ]
                    }
                )
        )


type alias Disposition =
    { operation : String, label : String, ready : Bool }


primaryDisposition : Model -> Disposition
primaryDisposition model =
    let
        action =
            String.trim model.nextAction

        context =
            String.trim model.context

        project =
            selectedProject model

        projectName =
            project |> Maybe.map .title |> Maybe.withDefault (projectPathTitle model.projectQuery model.snapshot.projects)

        actionSuffix =
            if String.isEmpty action then
                ""

            else
                " + Next Action"

        optionalReady =
            String.isEmpty action || not (String.isEmpty context)
    in
    if model.someday then
        let
            target =
                case project of
                    Just found ->
                        "Move " ++ found.title ++ " to Someday/Maybe"

                    Nothing ->
                        "Create Someday/Maybe Project"
        in
        { operation = "someday"
        , label = target ++ actionSuffix
        , ready = optionalReady
        }

    else if model.fileOriginal then
        { operation = "file"
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
        { operation = "next-action"
        , label =
            if String.isEmpty projectName then
                "Create Next Action"

            else if project /= Nothing then
                "Create Next Action in " ++ projectName

            else
                "Create Project + Next Action"
        , ready = not (String.isEmpty action) && not (String.isEmpty context)
        }


processCommand : String -> String -> Model -> Encode.Value
processCommand itemId operation model =
    let
        inputFields =
            optionalString "projectId" model.projectId
                ++ optionalString "projectTitle" (String.trim model.projectQuery)
                ++ optionalString "desiredOutcome" (String.trim model.desiredOutcome)
                ++ optionalString "nextAction" (String.trim model.nextAction)
                ++ optionalString "context" (String.trim model.context)
                ++ [ ( "work", Encode.bool model.work ), ( "fileOriginal", Encode.bool model.fileOriginal ) ]
    in
    Encode.object
        [ ( "type", Encode.string "process-inbox" )
        , ( "itemId", Encode.string itemId )
        , ( "operation", Encode.string operation )
        , ( "input", Encode.object inputFields )
        ]


optionalString : String -> String -> List ( String, Encode.Value )
optionalString key raw =
    if String.isEmpty raw then
        []

    else
        [ ( key, Encode.string raw ) ]


fileOriginalHint : Model -> InboxItem -> String
fileOriginalHint model item =
    if model.someday then
        "Keeps this capture as Project support material. Otherwise it goes to Obsidian's trash once the Project exists."

    else if item.file.extension == "md" then
        "Keeps this note as reference and creates a separate Action. Otherwise the note itself becomes the Action."

    else
        "Keeps this file as support material, or in General Reference with no Project. Otherwise it goes to Obsidian's trash once processed."


selectedProject : Model -> Maybe Project
selectedProject model =
    if not (String.isEmpty model.projectId) then
        findProject model.projectId model.snapshot.projects

    else
        let
            query =
                String.toLower (String.trim model.projectQuery)
        in
        model.snapshot.projects
            |> List.filter (\project -> String.toLower project.title == query || String.toLower (projectBreadcrumb model.snapshot.projects project) == query)
            |> List.head


currentItem : Model -> Maybe InboxItem
currentItem model =
    let
        items =
            sortedItems model.snapshot.inboxItems

        length_ =
            List.length items
    in
    if length_ == 0 then
        Nothing

    else
        List.drop (modBy length_ model.cursor) items |> List.head


sortedItems : List InboxItem -> List InboxItem
sortedItems =
    List.sortBy (\item -> ( item.created, item.id ))


indexOf : String -> List InboxItem -> Maybe Int
indexOf wanted items =
    items |> List.indexedMap Tuple.pair |> List.filter (\( _, item ) -> item.id == wanted) |> List.head |> Maybe.map Tuple.first


findProject : String -> List Project -> Maybe Project
findProject projectId projects =
    List.filter (\project -> project.id == projectId) projects |> List.head


projectBreadcrumb : List Project -> Project -> String
projectBreadcrumb projects project =
    let
        walk seen current =
            if Set.member current.id seen then
                [ current.title ]

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent ++ [ current.title ]

                    Nothing ->
                        [ current.title ]
    in
    String.join " > " (walk Set.empty project)


projectPathTitle : String -> List Project -> String
projectPathTitle query projects =
    let
        title_ =
            String.trim query

        separators =
            String.indexes ">" title_
    in
    case List.reverse separators |> List.head of
        Nothing ->
            title_

        Just separatorIndex ->
            let
                prefix =
                    String.left separatorIndex title_ |> String.trim

                leaf =
                    String.dropLeft (separatorIndex + 1) title_ |> String.trim

                normalized =
                    String.toLower prefix

                breadcrumbMatch =
                    List.any (\project -> String.toLower (projectBreadcrumb projects project) == normalized) projects

                titleMatches =
                    List.filter (\project -> String.toLower project.title == normalized) projects |> List.length
            in
            if not (String.isEmpty prefix) && not (String.isEmpty leaf) && (breadcrumbMatch || titleMatches == 1) then
                leaf

            else
                title_


allContexts : List Action -> List String
allContexts actions =
    actions |> List.filterMap .context |> Set.fromList |> Set.toList |> List.sort


fuzzyMatch : String -> List String -> Bool
fuzzyMatch query candidates =
    let
        needle =
            String.toLower (String.trim query)
    in
    String.isEmpty needle || List.any (String.toLower >> String.contains needle) candidates


isAudio : String -> Bool
isAudio extension =
    Set.member (String.toLower extension) (Set.fromList [ "3gp", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm" ])


formatTimer : Int -> String
formatTimer seconds =
    String.fromInt (seconds // 60) ++ ":" ++ String.padLeft 2 '0' (String.fromInt (modBy 60 seconds))


requestIdFor : Model -> String
requestIdFor model =
    "elm-inbox-" ++ String.fromInt model.nextRequest


envelope : String -> Encode.Value -> Encode.Value
envelope requestId command =
    Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ]


type alias RawSnapshot =
    { revision : Int, inboxItems : List InboxItem, actions : List Action, projects : List Project, issues : List Issue }


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map2 Flags (Decode.field "snapshot" snapshotDecoder) (Decode.field "initialProcessing" Decode.bool)


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.map5 Snapshot (Decode.field "revision" Decode.int) (Decode.field "inboxItems" (Decode.list inboxItemDecoder)) (Decode.field "actions" (Decode.list actionDecoder)) (Decode.field "projects" (Decode.list projectDecoder)) (Decode.field "issues" (Decode.list issueDecoder))


inboxItemDecoder : Decoder InboxItem
inboxItemDecoder =
    Decode.map6 InboxItem (Decode.field "id" Decode.string) (Decode.field "title" Decode.string) (Decode.field "created" Decode.string) (Decode.field "file" fileDecoder) (Decode.field "resourceUrl" Decode.string) (optionalField "legacyAction" Decode.bool False)


fileDecoder : Decoder File
fileDecoder =
    Decode.map2 File (Decode.field "path" Decode.string) (Decode.field "extension" Decode.string)


actionDecoder : Decoder Action
actionDecoder =
    Decode.map Action (optionalField "context" (Decode.maybe Decode.string) Nothing)


projectDecoder : Decoder Project
projectDecoder =
    Decode.map5 Project (Decode.field "id" Decode.string) (Decode.field "title" Decode.string) (Decode.field "status" Decode.string) (optionalField "area" (Decode.maybe Decode.string) Nothing) (optionalField "parentProjectId" (Decode.maybe Decode.string) Nothing)


issueDecoder : Decoder Issue
issueDecoder =
    Decode.map2 Issue (Decode.field "path" Decode.string) (Decode.field "message" Decode.string)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" snapshotDecoder)

                    "start-processing" ->
                        Decode.succeed StartProcessingEvent

                    "command-result" ->
                        Decode.map4 CommandResult (Decode.field "requestId" Decode.string) (Decode.field "ok" Decode.bool) (optionalField "error" (Decode.maybe Decode.string) Nothing) (optionalField "value" (Decode.maybe Decode.string) Nothing)

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]


emptyFlags : Flags
emptyFlags =
    { snapshot = { revision = 0, inboxItems = [], actions = [], projects = [], issues = [] }, initialProcessing = False }
