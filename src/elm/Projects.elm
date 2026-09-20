port module Projects exposing (main)

import Browser
import Dict exposing (Dict)
import Html exposing (Html, article, button, div, h2, h3, header, img, input, label, main_, node, p, section, small, span, strong, text, textarea)
import Html.Attributes exposing (alt, attribute, checked, class, classList, disabled, draggable, placeholder, rows, src, title, type_, value)
import Html.Events exposing (custom, on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)


port projectsToHost : Encode.Value -> Cmd msg


port projectsFromHost : (Decode.Value -> msg) -> Sub msg


protocolVersion : Int
protocolVersion =
    1


boardStatuses : List String
boardStatuses =
    [ "active", "backlog", "someday", "completed" ]


type alias File =
    { path : String, name : String, basename : String, extension : String }


type alias Action =
    { id : String
    , title : String
    , file : File
    , status : String
    , projectId : Maybe String
    , context : Maybe String
    , due : Maybe String
    }


type alias Project =
    { id : String
    , title : String
    , file : File
    , status : String
    , area : Maybe String
    , reviewed : Maybe String
    , activateAt : Maybe String
    , supportPath : Maybe String
    , image : Maybe String
    , tags : List String
    , order : Maybe Int
    , blockedByProjectIds : List String
    , parentProjectId : Maybe String
    }


type alias Settings =
    { showProjectBoardImages : Bool, projectBoardColumns : List String }


type alias Snapshot =
    { revision : Int, actions : List Action, projects : List Project, settings : Settings }


type alias ProjectMeta =
    { id : String
    , breadcrumb : String
    , activeSubprojects : Int
    , supportFiles : Int
    , imageUrl : String
    , actionIssue : Maybe String
    , blockers : List String
    }


type alias DiaryEntry =
    { timestamp : String, body : String }


type alias SupportFile =
    { path : String, label : String, kind : String, resourceUrl : String }


type alias SupportFolder =
    { path : String, label : String }


type alias ProjectDetail =
    { projectId : String
    , desiredOutcome : String
    , diary : List DiaryEntry
    , supportFiles : List SupportFile
    , supportFolders : List SupportFolder
    }


type Pending
    = ReadSupport String
    | AddDiary
    | CreateSupport
    | Ignore


type alias Model =
    { snapshot : Snapshot
    , meta : Dict String ProjectMeta
    , selectedProjectId : Maybe String
    , detail : Maybe ProjectDetail
    , search : String
    , showSubprojects : Bool
    , showImages : Bool
    , visibleColumns : List String
    , columnsOpen : Bool
    , selecting : Bool
    , selectedIds : Set String
    , showCompleted : Bool
    , showSecondary : Bool
    , tagFilters : Set String
    , outcomeEditing : Bool
    , outcomeDraft : String
    , diaryDraft : String
    , supportNoteTitle : String
    , supportFolderPath : String
    , openSupport : Set String
    , editingSupport : Maybe String
    , supportBodies : Dict String String
    , supportDraft : String
    , draggedProject : Maybe String
    , nextRequest : Int
    , pending : Dict String Pending
    , error : Maybe String
    , isMac : Bool
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleColumns
    | ToggleColumn String
    | ToggleSelecting
    | ToggleSelected String
    | SelectAll
    | ClearSelection
    | ToggleSubprojects Bool
    | ToggleImages Bool
    | SelectProject String
    | BackToBoard
    | ToggleCompleted
    | ToggleSecondary
    | ToggleTag String
    | ClearTags
    | BeginOutcome
    | CancelOutcome
    | OutcomeChanged String
    | SaveOutcome
    | DiaryChanged String
    | AddDiaryEntry
    | SupportNoteTitleChanged String
    | CreateSupportNote
    | SupportFolderChanged String
    | CreateSupportFolder
    | ToggleSupport SupportFile
    | BeginSupportEdit SupportFile
    | SupportDraftChanged String
    | CancelSupportEdit
    | SaveSupportNote String
    | DragStarted String
    | DragOver
    | DropProject String
    | DropSubproject String (Maybe String)
    | HostCommand Pending Encode.Value
    | OpenProjectMenu Float Float Project
    | OpenSubprojectMenu Float Float Project
    | OpenActionMenu Float Float Action
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> projectsFromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            let
                columns =
                    decoded.snapshot.settings.projectBoardColumns
                        |> List.filter (\status -> List.member status boardStatuses)

                model =
                    { snapshot = decoded.snapshot
                    , meta = Dict.fromList (List.map (\item -> ( item.id, item )) decoded.projectMeta)
                    , selectedProjectId = decoded.initialProjectId
                    , detail = Nothing
                    , search = ""
                    , showSubprojects = True
                    , showImages = decoded.snapshot.settings.showProjectBoardImages
                    , visibleColumns =
                        if List.isEmpty columns then
                            boardStatuses

                        else
                            columns
                    , columnsOpen = False
                    , selecting = False
                    , selectedIds = Set.empty
                    , showCompleted = False
                    , showSecondary = False
                    , tagFilters = Set.empty
                    , outcomeEditing = False
                    , outcomeDraft = ""
                    , diaryDraft = ""
                    , supportNoteTitle = ""
                    , supportFolderPath = ""
                    , openSupport = Set.empty
                    , editingSupport = Nothing
                    , supportBodies = Dict.empty
                    , supportDraft = ""
                    , draggedProject = Nothing
                    , nextRequest = 1
                    , pending = Dict.empty
                    , error = Nothing
                    , isMac = decoded.isMac
                    }
            in
            case decoded.initialProjectId of
                Just projectId ->
                    send Ignore (loadDetailCommand projectId) model

                Nothing ->
                    ( model, Cmd.none )

        Err error ->
            ( emptyModel (Decode.errorToString error), Cmd.none )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value_ ->
            receiveHost value_ model

        SearchChanged query ->
            ( { model | search = query }, Cmd.none )

        ToggleColumns ->
            ( { model | columnsOpen = not model.columnsOpen }, Cmd.none )

        ToggleColumn status ->
            let
                next =
                    if List.member status model.visibleColumns then
                        List.filter ((/=) status) model.visibleColumns

                    else
                        boardStatuses |> List.filter (\candidate -> candidate == status || List.member candidate model.visibleColumns)
            in
            if List.isEmpty next then
                ( model, Cmd.none )

            else
                savePreferences { model | visibleColumns = next }

        ToggleSelecting ->
            ( { model | selecting = not model.selecting, selectedIds = Set.empty }, Cmd.none )

        ToggleSelected id_ ->
            ( { model | selectedIds = toggleSet id_ model.selectedIds }, Cmd.none )

        SelectAll ->
            ( { model | selectedIds = Set.fromList (List.map .id (visibleProjects model)) }, Cmd.none )

        ClearSelection ->
            ( { model | selectedIds = Set.empty }, Cmd.none )

        ToggleSubprojects visible ->
            ( { model | showSubprojects = visible }, Cmd.none )

        ToggleImages visible ->
            savePreferences { model | showImages = visible }

        SelectProject projectId ->
            selectProject projectId model

        BackToBoard ->
            let
                next =
                    { model | selectedProjectId = Nothing, detail = Nothing, outcomeEditing = False, editingSupport = Nothing }
            in
            send Ignore selectionCommand next

        ToggleCompleted ->
            ( { model | showCompleted = not model.showCompleted }, Cmd.none )

        ToggleSecondary ->
            ( { model | showSecondary = not model.showSecondary }, Cmd.none )

        ToggleTag tag ->
            ( { model | tagFilters = toggleSet tag model.tagFilters }, Cmd.none )

        ClearTags ->
            ( { model | tagFilters = Set.empty }, Cmd.none )

        BeginOutcome ->
            ( { model | outcomeEditing = True, outcomeDraft = Maybe.map .desiredOutcome model.detail |> Maybe.withDefault "" }, Cmd.none )

        CancelOutcome ->
            ( { model | outcomeEditing = False }, Cmd.none )

        OutcomeChanged body ->
            ( { model | outcomeDraft = body }, Cmd.none )

        SaveOutcome ->
            case model.selectedProjectId of
                Just projectId ->
                    let
                        detail =
                            Maybe.map (\current -> { current | desiredOutcome = String.trim model.outcomeDraft }) model.detail
                    in
                    send Ignore (bodyCommand "set-desired-outcome" projectId (String.trim model.outcomeDraft)) { model | detail = detail, outcomeEditing = False }

                Nothing ->
                    ( model, Cmd.none )

        DiaryChanged body ->
            ( { model | diaryDraft = body }, Cmd.none )

        AddDiaryEntry ->
            case model.selectedProjectId of
                Just projectId ->
                    if String.isEmpty (String.trim model.diaryDraft) then
                        ( model, Cmd.none )

                    else
                        send AddDiary (bodyCommand "add-diary-entry" projectId (String.trim model.diaryDraft)) model

                Nothing ->
                    ( model, Cmd.none )

        SupportNoteTitleChanged value_ ->
            ( { model | supportNoteTitle = value_ }, Cmd.none )

        CreateSupportNote ->
            case model.selectedProjectId of
                Just projectId ->
                    if String.isEmpty (String.trim model.supportNoteTitle) then
                        ( model, Cmd.none )

                    else
                        send CreateSupport (supportTextCommand "create-support-note" "title" projectId (String.trim model.supportNoteTitle)) model

                Nothing ->
                    ( model, Cmd.none )

        SupportFolderChanged value_ ->
            ( { model | supportFolderPath = value_ }, Cmd.none )

        CreateSupportFolder ->
            case model.selectedProjectId of
                Just projectId ->
                    if String.isEmpty (String.trim model.supportFolderPath) then
                        ( model, Cmd.none )

                    else
                        send Ignore (supportTextCommand "create-support-folder" "path" projectId (String.trim model.supportFolderPath)) { model | supportFolderPath = "" }

                Nothing ->
                    ( model, Cmd.none )

        ToggleSupport file ->
            let
                nextOpen =
                    toggleSet file.path model.openSupport

                next =
                    { model | openSupport = nextOpen }
            in
            if Set.member file.path nextOpen && file.kind == "note" && not (Dict.member file.path model.supportBodies) then
                readSupport file.path next

            else
                ( next, Cmd.none )

        BeginSupportEdit file ->
            if Dict.member file.path model.supportBodies then
                ( { model | openSupport = Set.insert file.path model.openSupport, editingSupport = Just file.path, supportDraft = Dict.get file.path model.supportBodies |> Maybe.withDefault "" }, Cmd.none )

            else
                readSupport file.path { model | openSupport = Set.insert file.path model.openSupport, editingSupport = Just file.path }

        SupportDraftChanged body ->
            ( { model | supportDraft = body }, Cmd.none )

        CancelSupportEdit ->
            ( { model | editingSupport = Nothing }, Cmd.none )

        SaveSupportNote path ->
            case model.selectedProjectId of
                Just projectId ->
                    let
                        next =
                            { model | supportBodies = Dict.insert path model.supportDraft model.supportBodies, editingSupport = Nothing }
                    in
                    send Ignore (supportUpdateCommand projectId path model.supportDraft) next

                Nothing ->
                    ( model, Cmd.none )

        DragStarted projectId ->
            ( { model | draggedProject = Just projectId }, Cmd.none )

        DragOver ->
            ( model, Cmd.none )

        DropProject status ->
            case model.draggedProject of
                Just projectId ->
                    send Ignore (projectStatusCommand projectId status) { model | draggedProject = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        DropSubproject status beforeId ->
            case model.draggedProject of
                Just projectId ->
                    send Ignore (moveSubprojectCommand projectId status beforeId) { model | draggedProject = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        HostCommand pending command ->
            send pending command model

        OpenProjectMenu x y project ->
            send Ignore (projectMenuCommand x y project) model

        OpenSubprojectMenu x y project ->
            send Ignore (subprojectMenuCommand x y model project) model

        OpenActionMenu x y action ->
            send Ignore (actionMenuCommand x y action) model

        NoOp ->
            ( model, Cmd.none )


type HostEvent
    = SnapshotEvent Snapshot
    | ProjectDetailEvent ProjectDetail
    | ShowProjectEvent (Maybe String)
    | CommandResult String Bool (Maybe String) Decode.Value


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value_ model =
    case Decode.decodeValue hostEventDecoder value_ of
        Err _ ->
            ( model, Cmd.none )

        Ok event ->
            case event of
                SnapshotEvent snapshot ->
                    let
                        ids =
                            Set.fromList (List.map .id snapshot.projects)

                        next =
                            { model | snapshot = snapshot, selectedIds = Set.intersect ids model.selectedIds }
                    in
                    case next.selectedProjectId of
                        Just projectId ->
                            if Set.member projectId ids then
                                send Ignore (loadDetailCommand projectId) next

                            else
                                ( { next | selectedProjectId = Nothing, detail = Nothing }, Cmd.none )

                        Nothing ->
                            ( next, Cmd.none )

                ProjectDetailEvent detail ->
                    if model.selectedProjectId == Just detail.projectId then
                        ( { model | detail = Just detail, outcomeDraft = detail.desiredOutcome }, Cmd.none )

                    else
                        ( model, Cmd.none )

                ShowProjectEvent maybeId ->
                    case maybeId of
                        Just projectId ->
                            selectProject projectId model

                        Nothing ->
                            ( { model | selectedProjectId = Nothing, detail = Nothing }, Cmd.none )

                CommandResult requestId ok maybeError resultValue ->
                    if requestId == "project-meta" then
                        case Decode.decodeValue (Decode.list projectMetaDecoder) resultValue of
                            Ok items ->
                                ( { model | meta = Dict.fromList (List.map (\item -> ( item.id, item )) items) }, Cmd.none )

                            Err _ ->
                                ( model, Cmd.none )

                    else
                        let
                            pending =
                                Dict.get requestId model.pending |> Maybe.withDefault Ignore

                            next =
                                { model
                                    | pending = Dict.remove requestId model.pending
                                    , error =
                                        if ok then
                                            Nothing

                                        else
                                            maybeError
                                }
                        in
                        if not ok then
                            ( next, Cmd.none )

                        else
                            finishPending pending resultValue next


finishPending : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finishPending pending resultValue model =
    case pending of
        ReadSupport path ->
            case Decode.decodeValue Decode.string resultValue of
                Ok body ->
                    ( { model
                        | supportBodies = Dict.insert path body model.supportBodies
                        , supportDraft =
                            if model.editingSupport == Just path then
                                body

                            else
                                model.supportDraft
                      }
                    , Cmd.none
                    )

                Err _ ->
                    ( model, Cmd.none )

        AddDiary ->
            case Decode.decodeValue diaryDecoder resultValue of
                Ok entry ->
                    ( { model | detail = Maybe.map (\detail -> { detail | diary = entry :: detail.diary }) model.detail, diaryDraft = "" }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        CreateSupport ->
            case Decode.decodeValue Decode.string resultValue of
                Ok path ->
                    case model.selectedProjectId of
                        Just projectId ->
                            send (ReadSupport path) (readSupportCommand projectId path) { model | supportNoteTitle = "", openSupport = Set.insert path model.openSupport, editingSupport = Just path }

                        Nothing ->
                            ( model, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        Ignore ->
            ( model, Cmd.none )


selectProject : String -> Model -> ( Model, Cmd Msg )
selectProject projectId model =
    let
        next =
            { model | selectedProjectId = Just projectId, detail = Nothing, showCompleted = False, showSecondary = False, tagFilters = Set.empty, outcomeEditing = False, editingSupport = Nothing }

        ( afterSelection, selectionCmd ) =
            send Ignore (selectionProjectCommand projectId) next

        ( finalModel, detailCmd ) =
            send Ignore (loadDetailCommand projectId) afterSelection
    in
    ( finalModel, Cmd.batch [ selectionCmd, detailCmd ] )


readSupport : String -> Model -> ( Model, Cmd Msg )
readSupport path model =
    case model.selectedProjectId of
        Just projectId ->
            send (ReadSupport path) (readSupportCommand projectId path) model

        Nothing ->
            ( model, Cmd.none )


send : Pending -> Encode.Value -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        requestId =
            "projects-" ++ String.fromInt model.nextRequest

        envelope =
            Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ]
    in
    ( { model | nextRequest = model.nextRequest + 1, pending = Dict.insert requestId pending model.pending }, projectsToHost envelope )


savePreferences : Model -> ( Model, Cmd Msg )
savePreferences model =
    send Ignore
        (Encode.object
            [ ( "type", Encode.string "save-project-preferences" )
            , ( "columns", Encode.list Encode.string model.visibleColumns )
            , ( "showImages", Encode.bool model.showImages )
            ]
        )
        model


view : Model -> Html Msg
view model =
    case model.error of
        Just message ->
            div [ class "dg-view dg-projects-view" ] [ div [ class "dg-panel dg-error" ] [ text message ], viewBody model ]

        Nothing ->
            viewBody model


viewBody : Model -> Html Msg
viewBody model =
    case model.selectedProjectId |> Maybe.andThen (\id_ -> findProject id_ model.snapshot.projects) of
        Just project ->
            viewDetail model project

        Nothing ->
            viewBoard model


viewBoard : Model -> Html Msg
viewBoard model =
    div [ class "dg-view dg-projects-view" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Projects" ], span [ class "dg-count" ] [ text (String.fromInt (List.length model.snapshot.projects)) ] ]
            , div [ class "dg-header-actions" ]
                [ button [ onClick (HostCommand Ignore (createActionCommand Nothing)) ] [ text "New Action" ]
                , button [ class "mod-cta", onClick (HostCommand Ignore (createProjectCommand Nothing)) ] [ text "New Project" ]
                ]
            ]
        , div [ class "dg-toolbar dg-project-toolbar" ]
            [ input [ type_ "search", placeholder "Search Projects", value model.search, onInput SearchChanged ] []
            , button [ classList [ ( "is-active", model.columnsOpen ) ], onClick ToggleColumns ] [ text "Columns" ]
            , button [ classList [ ( "is-active", model.selecting ) ], attribute "aria-pressed" (boolString model.selecting), onClick ToggleSelecting ] [ text "Select" ]
            , label [ class "dg-toolbar-toggle", title "Show project images on board cards" ] [ input [ type_ "checkbox", checked model.showImages, onCheck ToggleImages ] [], span [] [ text "Images" ] ]
            , label [ class "dg-toolbar-toggle", title "Show sub-projects on the board" ] [ input [ type_ "checkbox", checked model.showSubprojects, onCheck ToggleSubprojects ] [], span [] [ text "Sub-projects" ] ]
            ]
        , if model.columnsOpen then
            viewColumnPicker model

          else
            text ""
        , if model.selecting then
            viewBatchBar model

          else
            text ""
        , div [ class "dg-board dg-project-board", attribute "role" "list" ] (List.filter (\status -> List.member status model.visibleColumns) boardStatuses |> List.map (viewProjectColumn model))
        ]


viewColumnPicker : Model -> Html Msg
viewColumnPicker model =
    div [ class "dg-panel dg-column-picker" ]
        (List.map
            (\status ->
                let
                    isChecked =
                        List.member status model.visibleColumns
                in
                label [] [ input [ type_ "checkbox", checked isChecked, disabled (isChecked && List.length model.visibleColumns == 1), onCheck (\_ -> ToggleColumn status) ] [], text (statusLabel status) ]
            )
            boardStatuses
        )


viewBatchBar : Model -> Html Msg
viewBatchBar model =
    let
        ids =
            Set.toList model.selectedIds
    in
    div [ class "dg-panel dg-batch-bar", attribute "role" "toolbar" ]
        [ span [ class "dg-batch-count" ] [ strong [] [ text (String.fromInt (List.length ids)) ], text " selected" ]
        , button [ disabled (List.isEmpty ids), onClick (HostCommand Ignore (idsCommand "batch-project-tags" ids)) ] [ text "Add tag…" ]
        , button [ disabled (List.isEmpty ids), onClick (HostCommand Ignore (idsCommand "batch-project-parent" ids)) ] [ text "Set parent…" ]
        , button [ class "dg-batch-delete", disabled (List.isEmpty ids), onClick (HostCommand Ignore (idsCommand "trash-projects" ids)) ] [ text "Delete…" ]
        , span [ class "dg-batch-spacer" ] []
        , button [ onClick SelectAll ] [ text "Select all shown" ]
        , button [ disabled (List.isEmpty ids), onClick ClearSelection ] [ text "Clear" ]
        ]


viewProjectColumn : Model -> String -> Html Msg
viewProjectColumn model status =
    let
        projects =
            visibleProjects model |> List.filter (\project -> project.status == status)

        issues =
            projects |> List.filter (\project -> projectMeta project.id model |> .actionIssue |> (/=) Nothing) |> List.length
    in
    section [ class "dg-column dg-project-column", attribute "data-column" status, dragOver, on "drop" (Decode.succeed (DropProject status)) ]
        [ header [ class "dg-column-header" ]
            [ span [] [ text (statusLabel status) ]
            , span [ class "dg-project-column-counts" ]
                ([ span [ title "Projects in column" ] [ text (String.fromInt (List.length projects)) ] ]
                    ++ (if status == "active" then
                            [ span [ class "dg-project-column-health", title "Active Projects with Action issues" ] [ text (String.fromInt issues ++ " issues") ] ]

                        else
                            []
                       )
                )
            ]
        , div [ class "dg-card-list" ]
            (if List.isEmpty projects then
                [ div [ class "dg-empty-row" ] [ text ("No " ++ String.toLower (statusLabel status) ++ " Projects.") ] ]

             else
                List.map (viewProjectCard model) projects
            )
        ]


viewProjectCard : Model -> Project -> Html Msg
viewProjectCard model project =
    let
        meta =
            projectMeta project.id model

        actions =
            List.filter (\action -> action.projectId == Just project.id) model.snapshot.actions

        openCount =
            List.filter (\action -> not (List.member action.status [ "done", "cancelled" ])) actions |> List.length

        selected =
            Set.member project.id model.selectedIds

        cardClick =
            if model.selecting then
                ToggleSelected project.id

            else
                NoOp

        titleClick =
            if model.selecting then
                NoOp

            else
                SelectProject project.id
    in
    article
        [ classList [ ( "dg-card dg-project-card", True ), ( "is-selectable", model.selecting ), ( "is-selected", selected ) ]
        , attribute "data-project-card" project.id
        , draggable (boolString (not model.selecting))
        , on "dragstart" (Decode.succeed (DragStarted project.id))
        , onClick cardClick
        ]
        [ if model.showImages && not (String.isEmpty meta.imageUrl) then
            div [ class "dg-project-card-image" ] [ img [ src meta.imageUrl, alt "" ] [] ]

          else
            text ""
        , div [ class "dg-card-title-row" ]
            [ if model.selecting then
                input [ class "dg-batch-checkbox", type_ "checkbox", checked selected ] []

              else
                text ""
            , button [ class "dg-card-title", title meta.breadcrumb, onClick titleClick ] [ text project.title ]
            , button ([ class "dg-icon-button", attribute "aria-label" ("Actions for " ++ project.title) ] ++ pointerEvent (OpenProjectMenu 0 0 project)) [ text "•••" ]
            ]
        , if meta.breadcrumb /= project.title then
            div [ class "dg-project-lineage", title meta.breadcrumb ] [ text meta.breadcrumb ]

          else
            text ""
        , maybeView project.area (\area -> div [ class "dg-project-area" ] [ text area ])
        , div [ class "dg-project-tags" ] (List.map (\tag -> span [] [ text ("#" ++ tag) ]) project.tags)
        , div [ class "dg-project-metrics" ]
            [ span [ title "Open Actions" ] [ strong [] [ text (String.fromInt openCount) ], text " open" ]
            , span [ title "Active sub-projects, at any depth" ] [ strong [] [ text (String.fromInt meta.activeSubprojects) ], text " sub" ]
            , span [ title "Project support material files" ] [ strong [] [ text (String.fromInt meta.supportFiles) ], text " files" ]
            ]
        , maybeView project.reviewed (\reviewed -> div [ class "dg-project-reviewed" ] [ text ("Reviewed " ++ reviewed) ])
        , if project.status == "someday" then
            maybeView project.activateAt (\date -> div [ class "dg-project-reviewed" ] [ text ("Activates " ++ date) ])

          else
            text ""
        , maybeView meta.actionIssue (\issue -> div [ class "dg-project-health" ] [ text issue ])
        ]


viewDetail : Model -> Project -> Html Msg
viewDetail model project =
    let
        parent =
            project.parentProjectId |> Maybe.andThen (\id_ -> findProject id_ model.snapshot.projects)

        imageUrl =
            (projectMeta project.id model).imageUrl

        actions =
            List.filter (\action -> action.projectId == Just project.id) model.snapshot.actions

        openActions =
            List.filter (\action -> not (List.member action.status [ "done", "cancelled" ])) actions

        completedActions =
            List.filter (\action -> action.status == "done") actions
    in
    div [ class "dg-view dg-project-detail" ]
        [ header [ class "dg-view-header" ]
            [ div [ class "dg-detail-heading" ]
                [ maybeView parent (\item -> button [ class "dg-parent-back", onClick (SelectProject item.id) ] [ text ("← " ++ item.title) ])
                , button [ onClick BackToBoard ] [ text "← Projects" ]
                , h2 [] [ text project.title ]
                , span [ class ("dg-status dg-status-" ++ project.status) ] [ text (statusLabel project.status) ]
                ]
            , div [ class "dg-header-actions" ]
                [ button [ onClick (HostCommand Ignore (openFileCommand project.file.path)) ] [ text "Open note" ]
                , button [ onClick (HostCommand Ignore (projectIdCommand "edit-project" project.id)) ] [ text "Edit" ]
                ]
            ]
        , main_ [ class "dg-project-detail-content" ]
            [ if not (String.isEmpty imageUrl) then
                div [ class "dg-project-main-image" ] [ img [ src imageUrl, alt ("Main image for " ++ project.title) ] [] ]

              else
                text ""
            , viewOutcome model project
            , viewActionsSection model project openActions completedActions
            , viewSubprojects model project
            , viewDiary model
            , viewSupport model project
            ]
        ]


viewOutcome : Model -> Project -> Html Msg
viewOutcome model project =
    let
        outcome =
            Maybe.map .desiredOutcome model.detail |> Maybe.withDefault ""

        chord =
            if model.isMac then
                "⌘+Enter"

            else
                "Ctrl+Enter"
    in
    section [ class "dg-detail-section dg-project-outcome-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Outcome" ], h3 [] [ text "Desired outcome" ] ]
            , if model.outcomeEditing then
                text ""

              else
                div [ class "dg-detail-section-actions" ]
                    [ button [ onClick BeginOutcome ]
                        [ text
                            (if String.isEmpty outcome then
                                "Write outcome"

                             else
                                "Edit"
                            )
                        ]
                    ]
            ]
        , if model.detail == Nothing then
            span [ class "dg-muted" ] [ text "Loading…" ]

          else if model.outcomeEditing then
            div [ class "dg-outcome-edit" ]
                [ textarea [ class "dg-outcome-input", value model.outcomeDraft, rows 5, placeholder ("What will be true when this Project is complete? (" ++ chord ++ " to save)"), onInput OutcomeChanged, onModEnter SaveOutcome ] []
                , div [ class "dg-outcome-edit-actions" ] [ button [ onClick CancelOutcome ] [ text "Cancel" ], button [ class "mod-cta", onClick SaveOutcome ] [ text "Save outcome" ] ]
                ]

          else if String.isEmpty outcome then
            div [ class "dg-detail-empty" ] [ text "No desired outcome written yet." ]

          else
            markdownView outcome project.file.path
        ]


viewActionsSection : Model -> Project -> List Action -> List Action -> Html Msg
viewActionsSection model project openActions completedActions =
    div []
        [ section [ class "dg-detail-section dg-project-actions-panel" ]
            [ div [ class "dg-detail-section-heading" ]
                [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Work" ], h3 [] [ text "Open Actions" ] ]
                , div [ class "dg-detail-section-actions" ]
                    [ span [ class "dg-detail-count" ] [ text (String.fromInt (List.length openActions)) ]
                    , button [ onClick (HostCommand Ignore (projectIdCommand "import-actions" project.id)) ] [ text "Import…" ]
                    , button [ class "mod-cta", onClick (HostCommand Ignore (createActionCommand (Just project.id))) ] [ text "New Action" ]
                    ]
                ]
            , viewActionRows openActions
            ]
        , if List.isEmpty completedActions then
            text ""

          else
            section [ class "dg-detail-section dg-completed-actions-panel" ]
                [ button [ class "dg-disclosure", onClick ToggleCompleted ]
                    [ span []
                        [ text
                            ((if model.showCompleted then
                                "▾"

                              else
                                "▸"
                             )
                                ++ " Completed Actions"
                            )
                        ]
                    , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length completedActions)) ]
                    ]
                , if model.showCompleted then
                    viewActionRows completedActions

                  else
                    text ""
                ]
        ]


viewActionRows : List Action -> Html Msg
viewActionRows actions =
    if List.isEmpty actions then
        div [ class "dg-detail-empty" ] [ text "No Actions." ]

    else
        div [ class "dg-action-rows" ] (List.map viewActionRow actions)


viewActionRow : Action -> Html Msg
viewActionRow action =
    article [ class "dg-action-row" ]
        [ input
            [ class "dg-action-row-checkbox"
            , type_ "checkbox"
            , checked (action.status == "done")
            , attribute "aria-label"
                ((if action.status == "done" then
                    "Reopen "

                  else
                    "Complete "
                 )
                    ++ action.title
                )
            , onCheck
                (\done ->
                    HostCommand Ignore
                        (actionStatusCommand action.id
                            (if done then
                                "done"

                             else
                                "next"
                            )
                        )
                )
            ]
            []
        , div [ class "dg-action-row-main" ]
            [ span [ class "dg-action-row-title", title action.title ] [ text action.title ]
            , div [ class "dg-action-row-meta" ]
                ((if action.status == "next" then
                    []

                  else
                    [ span [ class ("dg-action-status dg-action-status-" ++ action.status) ] [ text (statusLabel action.status) ] ]
                 )
                    ++ maybeList action.context (\context -> span [] [ text ("@" ++ context) ])
                    ++ maybeList action.due (\due -> span [] [ text ("Due " ++ due) ])
                )
            ]
        , div [ class "dg-action-row-actions" ]
            [ button [ class "dg-action-row-edit", onClick (HostCommand Ignore (Encode.object [ ( "type", Encode.string "edit-action" ), ( "actionId", Encode.string action.id ) ])) ] [ text "Edit" ]
            , button [ class "dg-action-row-delete", onClick (HostCommand Ignore (Encode.object [ ( "type", Encode.string "trash-action" ), ( "actionId", Encode.string action.id ) ])) ] [ text "Delete" ]
            ]
        ]


viewSubprojects : Model -> Project -> Html Msg
viewSubprojects model project =
    let
        children =
            List.filter (\child -> child.parentProjectId == Just project.id) model.snapshot.projects |> List.sortWith compareProjects

        tags =
            children |> List.concatMap .tags |> uniqueSorted

        visible =
            if Set.isEmpty model.tagFilters then
                children

            else
                List.filter (\child -> Set.toList model.tagFilters |> List.all (\tag -> List.member tag child.tags)) children

        primary =
            List.filter (\child -> List.member child.status [ "active", "backlog" ]) visible

        secondary =
            List.filter (\child -> List.member child.status [ "someday", "completed" ]) visible
    in
    section [ class "dg-detail-section dg-subprojects-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Board" ], h3 [] [ text "Sub-projects" ] ]
            , div [ class "dg-detail-section-actions" ]
                [ span [ class "dg-detail-count" ]
                    [ text
                        (String.fromInt (List.length visible)
                            ++ (if List.length visible /= List.length children then
                                    "/" ++ String.fromInt (List.length children)

                                else
                                    ""
                               )
                        )
                    ]
                , button [ onClick (HostCommand Ignore (projectIdCommand "import-subprojects" project.id)) ] [ text "Import…" ]
                , button [ class "mod-cta", onClick (HostCommand Ignore (createProjectCommand (Just project.id))) ] [ text "New sub-project" ]
                ]
            ]
        , if List.isEmpty tags then
            text ""

          else
            div [ class "dg-subproject-toolbar" ]
                (span [] [ text "Filter by tag" ]
                    :: List.map (\tag -> button [ classList [ ( "is-active", Set.member tag model.tagFilters ) ], onClick (ToggleTag tag) ] [ text ("#" ++ tag) ]) tags
                    ++ (if Set.isEmpty model.tagFilters then
                            []

                        else
                            [ button [ onClick ClearTags ] [ text "Clear" ] ]
                       )
                )
        , div [ class "dg-subproject-columns dg-subproject-columns-primary" ] (List.map (viewSubprojectColumn model primary) [ "active", "backlog" ])
        , div [ classList [ ( "dg-subproject-secondary", True ), ( "is-open", model.showSecondary ) ] ]
            [ button [ class "dg-disclosure dg-subproject-secondary-toggle", onClick ToggleSecondary ]
                [ span []
                    [ text
                        ((if model.showSecondary then
                            "▾"

                          else
                            "▸"
                         )
                            ++ " Someday/Maybe and Done"
                        )
                    ]
                , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length secondary)) ]
                ]
            , if model.showSecondary then
                div [ class "dg-subproject-columns dg-subproject-columns-secondary" ] (List.map (viewSubprojectColumn model secondary) [ "someday", "completed" ])

              else
                text ""
            ]
        ]


viewSubprojectColumn : Model -> List Project -> String -> Html Msg
viewSubprojectColumn model projects status =
    let
        items =
            List.filter (\project -> project.status == status) projects
    in
    div [ class "dg-subproject-column", attribute "data-subproject-column" status, dragOver, on "drop" (Decode.succeed (DropSubproject status Nothing)) ]
        [ header [] [ strong [] [ text (statusLabel status) ], span [] [ text (String.fromInt (List.length items)) ] ]
        , div [ class "dg-subproject-list" ]
            (if List.isEmpty items then
                [ div [ class "dg-subproject-empty" ] [ text ("No " ++ String.toLower (statusLabel status) ++ " sub-projects.") ] ]

             else
                List.map (viewSubprojectCard model) items
            )
        ]


viewSubprojectCard : Model -> Project -> Html Msg
viewSubprojectCard model project =
    let
        blockers =
            (projectMeta project.id model).blockers
    in
    article
        [ classList [ ( "dg-subproject-card", True ), ( "is-blocked", not (List.isEmpty blockers) ) ]
        , draggable "true"
        , on "dragstart" (Decode.succeed (DragStarted project.id))
        , custom "dragover" (Decode.succeed { message = DragOver, stopPropagation = True, preventDefault = True })
        , custom "drop" (Decode.succeed { message = DropSubproject project.status (Just project.id), stopPropagation = True, preventDefault = True })
        ]
        [ div [ class "dg-subproject-card-heading" ]
            [ button [ class "dg-subproject-title", onClick (SelectProject project.id) ] [ text project.title ]
            , button ([ class "dg-icon-button" ] ++ pointerEvent (OpenSubprojectMenu 0 0 project)) [ text "•••" ]
            ]
        , div [ class "dg-project-tags" ] (List.map (\tag -> span [] [ text ("#" ++ tag) ]) project.tags)
        , if List.isEmpty blockers then
            text ""

          else
            div [ class "dg-subproject-blocked", title (String.join ", " blockers) ]
                [ text
                    ("Blocked by "
                        ++ (if List.length blockers == 1 then
                                List.head blockers |> Maybe.withDefault ""

                            else
                                String.fromInt (List.length blockers) ++ " Projects"
                           )
                    )
                ]
        ]


viewDiary : Model -> Html Msg
viewDiary model =
    let
        entries =
            Maybe.map .diary model.detail |> Maybe.withDefault []

        chord =
            if model.isMac then
                "⌘+Enter"

            else
                "Ctrl+Enter"
    in
    section [ class "dg-detail-section dg-project-diary-panel" ]
        [ div [ class "dg-detail-section-heading" ] [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Log" ], h3 [] [ text "Diary" ] ], span [ class "dg-detail-count" ] [ text (String.fromInt (List.length entries)) ] ]
        , div [ class "dg-diary-add" ] [ textarea [ value model.diaryDraft, rows 3, placeholder ("Observation or decision… (" ++ chord ++ " to add)"), onInput DiaryChanged, onModEnter AddDiaryEntry ] [], button [ class "mod-cta", disabled (String.isEmpty (String.trim model.diaryDraft)), onClick AddDiaryEntry ] [ text "Add entry" ] ]
        , div [ class "dg-diary-list" ]
            (if model.detail == Nothing then
                [ span [ class "dg-muted" ] [ text "Loading…" ] ]

             else if List.isEmpty entries then
                [ span [ class "dg-muted" ] [ text "No entries yet." ] ]

             else
                List.map (\entry -> div [] [ span [] [ text entry.timestamp ], p [] [ text entry.body ] ]) entries
            )
        ]


viewSupport : Model -> Project -> Html Msg
viewSupport model project =
    let
        detail =
            model.detail

        files =
            Maybe.map .supportFiles detail |> Maybe.withDefault []

        folders =
            Maybe.map .supportFolders detail |> Maybe.withDefault []

        notesAndImages =
            List.filter (\file -> file.kind /= "attachment") files

        attachments =
            List.filter (\file -> file.kind == "attachment") files
    in
    section [ class "dg-detail-section dg-support-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Files" ], h3 [] [ text "Project Support Material" ] ]
            , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length files) ++ " files · " ++ String.fromInt (List.length folders) ++ " folders") ]
            ]
        , div [ class "dg-support-create" ]
            [ div [ class "dg-support-note-create" ] [ input [ value model.supportNoteTitle, placeholder "Note title…", onInput SupportNoteTitleChanged ] [], button [ class "mod-cta", disabled (String.isEmpty (String.trim model.supportNoteTitle)), onClick CreateSupportNote ] [ text "Create note" ] ]
            , div [ class "dg-support-folder-create" ] [ input [ value model.supportFolderPath, placeholder "Folder name or path…", onInput SupportFolderChanged ] [], button [ disabled (String.isEmpty (String.trim model.supportFolderPath)), onClick CreateSupportFolder ] [ text "Create folder" ] ]
            ]
        , if List.isEmpty folders then
            text ""

          else
            div [ class "dg-support-folders" ] [ span [] [ text "Folders" ], div [] (List.map (\folder -> span [ title folder.path ] [ text ("📁 " ++ folder.label) ]) folders) ]
        , div [ class "dg-support-notes" ] (List.map (viewSupportFile model) notesAndImages)
        , if List.isEmpty attachments then
            text ""

          else
            div [ class "dg-support-attachments" ] [ span [] [ text "Other files" ], div [] (List.map (\file -> button [ onClick (HostCommand Ignore (openFileCommand file.path)) ] [ text file.label ]) attachments) ]
        , if List.isEmpty files && List.isEmpty folders then
            span [ class "dg-support-empty" ] [ text "No support material yet." ]

          else
            text ""
        ]


viewSupportFile : Model -> SupportFile -> Html Msg
viewSupportFile model file =
    let
        open =
            Set.member file.path model.openSupport

        editing =
            model.editingSupport == Just file.path

        body =
            Dict.get file.path model.supportBodies
    in
    article [ classList [ ( "dg-support-note", True ), ( "dg-support-image", file.kind == "image" ), ( "is-open", open ) ] ]
        [ header []
            [ button [ class "dg-support-note-toggle", onClick (ToggleSupport file), attribute "aria-expanded" (boolString open) ]
                [ span []
                    [ text
                        (if open then
                            "▾"

                         else
                            "▸"
                        )
                    ]
                , span [ title file.label ] [ text file.label ]
                ]
            , div []
                ([ button [ onClick (HostCommand Ignore (openFileCommand file.path)) ] [ text "Open" ] ]
                    ++ (if file.kind == "note" then
                            [ button [ onClick (BeginSupportEdit file) ] [ text "Edit" ] ]

                        else
                            []
                       )
                )
            ]
        , if not open then
            text ""

          else
            div
                [ class
                    (if file.kind == "image" then
                        "dg-support-note-body dg-support-image-body"

                     else
                        "dg-support-note-body"
                    )
                ]
                [ if file.kind == "image" then
                    img [ src file.resourceUrl, alt file.label ] []

                  else if editing then
                    div [] [ textarea [ value model.supportDraft, onInput SupportDraftChanged ] [], div [ class "dg-support-note-edit-actions" ] [ button [ onClick CancelSupportEdit ] [ text "Cancel" ], button [ class "mod-cta", onClick (SaveSupportNote file.path) ] [ text "Save note" ] ] ]

                  else
                    case body of
                        Just content ->
                            if String.isEmpty content then
                                span [ class "dg-muted" ] [ text "This note is empty." ]

                            else
                                markdownView content file.path

                        Nothing ->
                            span [ class "dg-muted" ] [ text "Loading…" ]
                ]
        ]


visibleProjects : Model -> List Project
visibleProjects model =
    let
        query =
            String.toLower (String.trim model.search)

        matches project =
            let
                meta =
                    projectMeta project.id model

                haystack =
                    String.toLower (project.title ++ " " ++ meta.breadcrumb ++ " " ++ Maybe.withDefault "" project.area)
            in
            (String.isEmpty query || String.contains query haystack) && (model.showSubprojects || project.parentProjectId == Nothing) && List.member project.status model.visibleColumns
    in
    model.snapshot.projects |> List.filter matches |> List.sortBy (\project -> String.toLower (projectMeta project.id model).breadcrumb)


projectMeta : String -> Model -> ProjectMeta
projectMeta id_ model =
    Dict.get id_ model.meta |> Maybe.withDefault { id = id_, breadcrumb = "", activeSubprojects = 0, supportFiles = 0, imageUrl = "", actionIssue = Nothing, blockers = [] }


findProject : String -> List Project -> Maybe Project
findProject id_ projects =
    List.filter (\project -> project.id == id_) projects |> List.head


compareProjects : Project -> Project -> Order
compareProjects left right =
    case ( left.order, right.order ) of
        ( Just a, Just b ) ->
            compare ( a, left.title ) ( b, right.title )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        _ ->
            compare left.title right.title


uniqueSorted : List String -> List String
uniqueSorted values =
    values |> List.foldl Set.insert Set.empty |> Set.toList |> List.sort


toggleSet : comparable -> Set comparable -> Set comparable
toggleSet item items =
    if Set.member item items then
        Set.remove item items

    else
        Set.insert item items


statusLabel : String -> String
statusLabel status =
    case status of
        "active" ->
            "Active"

        "backlog" ->
            "Backlog"

        "someday" ->
            "Someday/Maybe"

        "completed" ->
            "Done"

        "cancelled" ->
            "Cancelled"

        _ ->
            status


maybeView : Maybe a -> (a -> Html msg) -> Html msg
maybeView maybeValue render =
    Maybe.map render maybeValue |> Maybe.withDefault (text "")


maybeList : Maybe a -> (a -> b) -> List b
maybeList maybeValue render =
    Maybe.map (render >> List.singleton) maybeValue |> Maybe.withDefault []


boolString : Bool -> String
boolString value_ =
    if value_ then
        "true"

    else
        "false"


dragOver : Html.Attribute Msg
dragOver =
    custom "dragover" (Decode.succeed { message = DragOver, stopPropagation = False, preventDefault = True })


pointerEvent : Msg -> List (Html.Attribute Msg)
pointerEvent fallback =
    [ custom "click"
        (Decode.map2
            (\x y -> { message = replacePointer fallback x y, stopPropagation = True, preventDefault = True })
            (Decode.field "clientX" Decode.float)
            (Decode.field "clientY" Decode.float)
        )
    ]


markdownView : String -> String -> Html Msg
markdownView markdown sourcePath =
    node "dg-markdown"
        [ class "dg-outcome markdown-rendered"
        , attribute "data-markdown" markdown
        , attribute "data-source-path" sourcePath
        ]
        []


replacePointer : Msg -> Float -> Float -> Msg
replacePointer message x y =
    case message of
        OpenProjectMenu _ _ project ->
            OpenProjectMenu x y project

        OpenSubprojectMenu _ _ project ->
            OpenSubprojectMenu x y project

        OpenActionMenu _ _ action ->
            OpenActionMenu x y action

        _ ->
            message


onModEnter : Msg -> Html.Attribute Msg
onModEnter message =
    custom "keydown"
        (Decode.map3
            (\key meta ctrl ->
                let
                    submit =
                        key == "Enter" && (meta || ctrl)
                in
                { message =
                    if submit then
                        message

                    else
                        NoOp
                , stopPropagation = submit
                , preventDefault = submit
                }
            )
            (Decode.field "key" Decode.string)
            (Decode.field "metaKey" Decode.bool)
            (Decode.field "ctrlKey" Decode.bool)
        )


simpleCommand : String -> Encode.Value
simpleCommand kind =
    Encode.object [ ( "type", Encode.string kind ) ]


projectIdCommand : String -> String -> Encode.Value
projectIdCommand kind projectId =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ) ]


createProjectCommand : Maybe String -> Encode.Value
createProjectCommand parentId =
    Encode.object ([ ( "type", Encode.string "create-project" ) ] ++ maybeField "parentProjectId" parentId)


createActionCommand : Maybe String -> Encode.Value
createActionCommand projectId =
    Encode.object ([ ( "type", Encode.string "create-action" ) ] ++ maybeField "projectId" projectId)


selectionCommand : Encode.Value
selectionCommand =
    simpleCommand "set-project-selection"


selectionProjectCommand : String -> Encode.Value
selectionProjectCommand projectId =
    projectIdCommand "set-project-selection" projectId


loadDetailCommand : String -> Encode.Value
loadDetailCommand projectId =
    projectIdCommand "load-project-detail" projectId


openFileCommand : String -> Encode.Value
openFileCommand path =
    Encode.object [ ( "type", Encode.string "open-file" ), ( "path", Encode.string path ) ]


projectStatusCommand : String -> String -> Encode.Value
projectStatusCommand projectId status =
    Encode.object [ ( "type", Encode.string "set-project-status" ), ( "projectId", Encode.string projectId ), ( "status", Encode.string status ) ]


moveSubprojectCommand : String -> String -> Maybe String -> Encode.Value
moveSubprojectCommand projectId status beforeId =
    Encode.object
        ([ ( "type", Encode.string "move-subproject" )
         , ( "projectId", Encode.string projectId )
         , ( "status", Encode.string status )
         ]
            ++ maybeField "beforeId" beforeId
        )


actionStatusCommand : String -> String -> Encode.Value
actionStatusCommand actionId status =
    Encode.object [ ( "type", Encode.string "set-action-status" ), ( "actionId", Encode.string actionId ), ( "status", Encode.string status ) ]


bodyCommand : String -> String -> String -> Encode.Value
bodyCommand kind projectId body =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ), ( "body", Encode.string body ) ]


supportTextCommand : String -> String -> String -> String -> Encode.Value
supportTextCommand kind field projectId value_ =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ), ( field, Encode.string value_ ) ]


readSupportCommand : String -> String -> Encode.Value
readSupportCommand projectId path =
    Encode.object [ ( "type", Encode.string "read-support-note" ), ( "projectId", Encode.string projectId ), ( "path", Encode.string path ) ]


supportUpdateCommand : String -> String -> String -> Encode.Value
supportUpdateCommand projectId path body =
    Encode.object [ ( "type", Encode.string "update-support-note" ), ( "projectId", Encode.string projectId ), ( "path", Encode.string path ), ( "body", Encode.string body ) ]


idsCommand : String -> List String -> Encode.Value
idsCommand kind ids =
    Encode.object [ ( "type", Encode.string kind ), ( "projectIds", Encode.list Encode.string ids ) ]


maybeField : String -> Maybe String -> List ( String, Encode.Value )
maybeField name maybeValue =
    Maybe.map (\value_ -> [ ( name, Encode.string value_ ) ]) maybeValue |> Maybe.withDefault []


menuEntry : String -> Encode.Value -> Encode.Value
menuEntry label_ command =
    Encode.object [ ( "label", Encode.string label_ ), ( "command", command ) ]


separator : Encode.Value
separator =
    Encode.object [ ( "separator", Encode.bool True ) ]


menuCommand : Float -> Float -> List Encode.Value -> Encode.Value
menuCommand x y entries =
    Encode.object [ ( "type", Encode.string "show-menu" ), ( "x", Encode.float x ), ( "y", Encode.float y ), ( "entries", Encode.list identity entries ) ]


projectMenuCommand : Float -> Float -> Project -> Encode.Value
projectMenuCommand x y project =
    menuCommand x
        y
        (List.map
            (\status ->
                menuEntry
                    ((if project.status == status then
                        "✓ "

                      else
                        ""
                     )
                        ++ statusLabel status
                    )
                    (projectStatusCommand project.id status)
            )
            boardStatuses
            ++ [ separator
               , menuEntry "New Action…" (createActionCommand (Just project.id))
               , menuEntry "New sub-project…" (createProjectCommand (Just project.id))
               , menuEntry "Open note" (openFileCommand project.file.path)
               , menuEntry "Edit…" (projectIdCommand "edit-project" project.id)
               , separator
               , menuEntry "Delete Project…" (projectIdCommand "trash-project" project.id)
               ]
        )


subprojectMenuCommand : Float -> Float -> Model -> Project -> Encode.Value
subprojectMenuCommand x y model project =
    let
        siblings =
            model.snapshot.projects
                |> List.filter (\candidate -> candidate.parentProjectId == project.parentProjectId && candidate.status == project.status)
                |> List.sortWith compareProjects

        priorityEntries =
            case findIndex project.id siblings of
                Just position ->
                    let
                        moveUp =
                            maybeList
                                (itemAt (position - 1) siblings)
                                (\before -> menuEntry "Move up" (moveSubprojectCommand project.id project.status (Just before.id)))

                        moveDown =
                            if position < List.length siblings - 1 then
                                [ menuEntry "Move down" (moveSubprojectCommand project.id project.status (itemAt (position + 2) siblings |> Maybe.map .id)) ]

                            else
                                []
                    in
                    moveUp ++ moveDown

                Nothing ->
                    []
    in
    menuCommand x
        y
        (List.map
            (\status ->
                menuEntry
                    ((if project.status == status then
                        "✓ "

                      else
                        ""
                     )
                        ++ statusLabel status
                    )
                    (moveSubprojectCommand project.id status Nothing)
            )
            boardStatuses
            ++ [ separator ]
            ++ priorityEntries
            ++ [ separator
               , menuEntry "Blocked by…" (projectIdCommand "project-dependencies" project.id)
               , menuEntry "Edit…" (projectIdCommand "edit-project" project.id)
               , menuEntry "Open note" (openFileCommand project.file.path)
               , menuEntry "New Action…" (createActionCommand (Just project.id))
               , menuEntry "New sub-project…" (createProjectCommand (Just project.id))
               , separator
               , menuEntry "Delete Project…" (projectIdCommand "trash-project" project.id)
               ]
        )


findIndex : String -> List Project -> Maybe Int
findIndex projectId projects =
    let
        walk position remaining =
            case remaining of
                [] ->
                    Nothing

                current :: rest ->
                    if current.id == projectId then
                        Just position

                    else
                        walk (position + 1) rest
    in
    walk 0 projects


itemAt : Int -> List a -> Maybe a
itemAt index items =
    if index < 0 then
        Nothing

    else
        List.drop index items |> List.head


actionMenuCommand : Float -> Float -> Action -> Encode.Value
actionMenuCommand x y action =
    menuCommand x
        y
        [ menuEntry
            (if action.status == "done" then
                "Reopen"

             else
                "Complete"
            )
            (actionStatusCommand action.id
                (if action.status == "done" then
                    "next"

                 else
                    "done"
                )
            )
        , menuEntry "Open note" (openFileCommand action.file.path)
        , menuEntry "Edit…" (Encode.object [ ( "type", Encode.string "edit-action" ), ( "actionId", Encode.string action.id ) ])
        , separator
        , menuEntry "Delete Action…" (Encode.object [ ( "type", Encode.string "trash-action" ), ( "actionId", Encode.string action.id ) ])
        ]


type alias Flags =
    { snapshot : Snapshot, projectMeta : List ProjectMeta, initialProjectId : Maybe String, isMac : Bool }


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map4 Flags (Decode.field "snapshot" snapshotDecoder) (Decode.field "projectMeta" (Decode.list projectMetaDecoder)) (Decode.field "initialProjectId" (Decode.maybe Decode.string)) (Decode.field "isMac" Decode.bool)


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.map4 Snapshot (Decode.field "revision" Decode.int) (Decode.field "actions" (Decode.list actionDecoder)) (Decode.field "projects" (Decode.list projectDecoder)) (Decode.field "settings" settingsDecoder)


settingsDecoder : Decoder Settings
settingsDecoder =
    Decode.map2 Settings (Decode.field "showProjectBoardImages" Decode.bool) (Decode.field "projectBoardColumns" (Decode.list Decode.string))


fileDecoder : Decoder File
fileDecoder =
    Decode.map4 File (Decode.field "path" Decode.string) (Decode.field "name" Decode.string) (Decode.field "basename" Decode.string) (Decode.field "extension" Decode.string)


actionDecoder : Decoder Action
actionDecoder =
    Decode.map7 Action
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "file" fileDecoder)
        (Decode.field "status" Decode.string)
        (optionalField "projectId" (Decode.maybe Decode.string) Nothing)
        (optionalField "context" (Decode.maybe Decode.string) Nothing)
        (optionalField "due" (Decode.maybe Decode.string) Nothing)


projectDecoder : Decoder Project
projectDecoder =
    Decode.succeed Project
        |> required "id" Decode.string
        |> required "title" Decode.string
        |> required "file" fileDecoder
        |> required "status" Decode.string
        |> optional "area" (Decode.maybe Decode.string) Nothing
        |> optional "reviewed" (Decode.maybe Decode.string) Nothing
        |> optional "activateAt" (Decode.maybe Decode.string) Nothing
        |> optional "supportPath" (Decode.maybe Decode.string) Nothing
        |> optional "image" (Decode.maybe Decode.string) Nothing
        |> optional "tags" (Decode.list Decode.string) []
        |> optional "order" (Decode.maybe Decode.int) Nothing
        |> optional "blockedByProjectIds" (Decode.list Decode.string) []
        |> optional "parentProjectId" (Decode.maybe Decode.string) Nothing


projectMetaDecoder : Decoder ProjectMeta
projectMetaDecoder =
    Decode.map7 ProjectMeta
        (Decode.field "id" Decode.string)
        (Decode.field "breadcrumb" Decode.string)
        (Decode.field "activeSubprojects" Decode.int)
        (Decode.field "supportFiles" Decode.int)
        (Decode.field "imageUrl" Decode.string)
        (Decode.field "actionIssue" (Decode.maybe Decode.string))
        (Decode.field "blockers" (Decode.list Decode.string))


diaryDecoder : Decoder DiaryEntry
diaryDecoder =
    Decode.map2 DiaryEntry (optionalField "timestamp" Decode.string "") (Decode.field "text" Decode.string)


supportFileDecoder : Decoder SupportFile
supportFileDecoder =
    Decode.map4 SupportFile (Decode.field "path" Decode.string) (Decode.field "label" Decode.string) (Decode.field "kind" Decode.string) (Decode.field "resourceUrl" Decode.string)


supportFolderDecoder : Decoder SupportFolder
supportFolderDecoder =
    Decode.map2 SupportFolder (Decode.field "path" Decode.string) (Decode.field "label" Decode.string)


projectDetailDecoder : Decoder ProjectDetail
projectDetailDecoder =
    Decode.map5 ProjectDetail
        (Decode.field "projectId" Decode.string)
        (Decode.field "desiredOutcome" Decode.string)
        (Decode.field "diary" (Decode.list diaryDecoder))
        (Decode.field "supportFiles" (Decode.list supportFileDecoder))
        (Decode.field "supportFolders" (Decode.list supportFolderDecoder))


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" snapshotDecoder)

                    "project-detail" ->
                        Decode.map ProjectDetailEvent (Decode.field "detail" projectDetailDecoder)

                    "show-project" ->
                        Decode.map ShowProjectEvent (Decode.field "projectId" (Decode.maybe Decode.string))

                    "command-result" ->
                        Decode.map4 CommandResult (Decode.field "requestId" Decode.string) (Decode.field "ok" Decode.bool) (optionalField "error" (Decode.maybe Decode.string) Nothing) (optionalField "value" Decode.value Encode.null)

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


required : String -> Decoder a -> Decoder (a -> b) -> Decoder b
required name decoder pipeline =
    Decode.map2 (<|) pipeline (Decode.field name decoder)


optional : String -> Decoder a -> a -> Decoder (a -> b) -> Decoder b
optional name decoder fallback pipeline =
    Decode.map2 (<|) pipeline (optionalField name decoder fallback)


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]


emptyModel : String -> Model
emptyModel message =
    { snapshot = { revision = 0, actions = [], projects = [], settings = { showProjectBoardImages = False, projectBoardColumns = boardStatuses } }
    , meta = Dict.empty
    , selectedProjectId = Nothing
    , detail = Nothing
    , search = ""
    , showSubprojects = True
    , showImages = False
    , visibleColumns = boardStatuses
    , columnsOpen = False
    , selecting = False
    , selectedIds = Set.empty
    , showCompleted = False
    , showSecondary = False
    , tagFilters = Set.empty
    , outcomeEditing = False
    , outcomeDraft = ""
    , diaryDraft = ""
    , supportNoteTitle = ""
    , supportFolderPath = ""
    , openSupport = Set.empty
    , editingSupport = Nothing
    , supportBodies = Dict.empty
    , supportDraft = ""
    , draggedProject = Nothing
    , nextRequest = 1
    , pending = Dict.empty
    , error = Just message
    , isMac = False
    }
