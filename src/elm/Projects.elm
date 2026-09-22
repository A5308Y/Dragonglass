port module Projects exposing (main)

import Browser
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.Projects as Command exposing (Command, MenuEntry(..))
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Ui as Ui
import Html exposing (Html, article, button, div, h2, h3, header, img, input, label, main_, node, p, section, small, span, strong, text, textarea)
import Html.Attributes exposing (alt, attribute, checked, class, classList, disabled, draggable, placeholder, rows, src, title, type_, value)
import Html.Events exposing (on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)


port projectsToHost : Encode.Value -> Cmd msg


port projectsFromHost : (Decode.Value -> msg) -> Sub msg


{-| Board metadata the host derives from the vault, which is deliberately not
part of the shared snapshot: image resource paths and support-file counts.
-}
type alias ProjectMeta =
    { id : ProjectId
    , breadcrumb : String
    , activeSubprojects : Int
    , supportFiles : Int
    , imageUrl : String
    , actionIssue : Maybe String
    , blockers : List String
    }


type alias DiaryEntry =
    { timestamp : String, body : String }


{-| What a support file is, and therefore how Project detail presents it.
-}
type SupportKind
    = SupportNote
    | SupportImage
    | SupportAttachment


type alias SupportFile =
    { path : String, label : String, kind : SupportKind, resourceUrl : String }


type alias SupportFolder =
    { path : String, label : String }


type alias ProjectDetail =
    { projectId : ProjectId
    , desiredOutcome : String
    , diary : List DiaryEntry
    , supportFiles : List SupportFile
    , supportFolders : List SupportFolder
    }


{-| The parts of Project detail, one shown at a time so a large Project does not
become one long scroll.
-}
type DetailTab
    = OverviewTab
    | SubprojectsTab
    | DiaryTab
    | FilesTab


type alias SubprojectDropTarget =
    { status : ProjectStatus
    , beforeId : Maybe ProjectId
    }


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | ReadSupport String
    | AppendDiary
    | OpenNewSupportNote


type alias Model =
    { snapshot : Snapshot
    , meta : Dict ProjectId ProjectMeta
    , selectedProjectId : Maybe ProjectId
    , detail : Maybe ProjectDetail
    , search : String
    , issuesOnly : Bool
    , showSubprojects : Bool
    , showImages : Bool
    , visibleColumns : List ProjectStatus
    , columnsOpen : Bool
    , selecting : Bool
    , selectedIds : Set ProjectId
    , showCompleted : Bool
    , showSecondary : Bool
    , detailTab : DetailTab
    , expandedColumns : List ProjectStatus
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
    , draggedProject : Maybe ProjectId
    , subprojectDropTarget : Maybe SubprojectDropTarget
    , requests : Requests Pending
    , error : Maybe String
    , isMac : Bool
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleIssues Bool
    | ToggleColumns
    | ToggleColumn ProjectStatus
    | ToggleSelecting
    | ToggleSelected ProjectId
    | SelectAll
    | ClearSelection
    | ToggleSubprojects Bool
    | ToggleImages Bool
    | SelectProject ProjectId
    | BackToBoard
    | ToggleCompleted
    | ToggleSecondary
    | SelectTab DetailTab
    | ToggleColumnExpanded ProjectStatus
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
    | DragStarted ProjectId
    | DragOver
    | DragOverSubproject ProjectStatus (Maybe ProjectId)
    | DragEnded
    | DropProject ProjectStatus
    | DropSubproject ProjectStatus (Maybe ProjectId)
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> projectsFromHost GotHost
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot
    , projectMeta : List ProjectMeta
    , initialProjectId : Maybe ProjectId
    , isMac : Bool
    }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            let
                columns =
                    List.filter (\status -> List.member status ProjectStatus.board) decoded.snapshot.settings.projectBoardColumns

                model =
                    { snapshot = decoded.snapshot
                    , meta = metaDict decoded.projectMeta
                    , selectedProjectId = decoded.initialProjectId
                    , detail = Nothing
                    , search = ""
                    , issuesOnly = False
                    , showSubprojects = False
                    , showImages = decoded.snapshot.settings.showProjectBoardImages
                    , visibleColumns =
                        if List.isEmpty columns then
                            ProjectStatus.board

                        else
                            columns
                    , columnsOpen = False
                    , selecting = False
                    , selectedIds = Set.empty
                    , showCompleted = False
                    , showSecondary = False
                    , detailTab = OverviewTab
                    , expandedColumns = []
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
                    , subprojectDropTarget = Nothing
                    , requests = Host.noRequests
                    , error = Nothing
                    , isMac = decoded.isMac
                    }
            in
            case decoded.initialProjectId of
                Just projectId ->
                    send IgnoreReply (Command.LoadProjectDetail projectId) model

                Nothing ->
                    ( model, Cmd.none )

        Err error ->
            ( emptyModel (Decode.errorToString error), Cmd.none )


metaDict : List ProjectMeta -> Dict ProjectId ProjectMeta
metaDict items =
    Dict.fromList (List.map (\item -> ( item.id, item )) items)


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        SearchChanged query ->
            ( { model | search = query }, Cmd.none )

        ToggleIssues enabled ->
            ( { model | issuesOnly = enabled }, Cmd.none )

        ToggleColumns ->
            ( { model | columnsOpen = not model.columnsOpen }, Cmd.none )

        ToggleColumn status ->
            let
                next =
                    if List.member status model.visibleColumns then
                        List.filter ((/=) status) model.visibleColumns

                    else
                        List.filter (\candidate -> candidate == status || List.member candidate model.visibleColumns) ProjectStatus.board
            in
            if List.isEmpty next then
                ( model, Cmd.none )

            else
                savePreferences { model | visibleColumns = next }

        ToggleSelecting ->
            ( { model | selecting = not model.selecting, selectedIds = Set.empty }, Cmd.none )

        ToggleSelected projectId ->
            ( { model | selectedIds = toggleSet projectId model.selectedIds }, Cmd.none )

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
            send IgnoreReply
                (Command.SetProjectSelection Nothing)
                { model | selectedProjectId = Nothing, detail = Nothing, outcomeEditing = False, editingSupport = Nothing }

        ToggleCompleted ->
            ( { model | showCompleted = not model.showCompleted }, Cmd.none )

        ToggleSecondary ->
            ( { model | showSecondary = not model.showSecondary }, Cmd.none )

        SelectTab tab ->
            ( { model | detailTab = tab }, Cmd.none )

        ToggleColumnExpanded status ->
            ( { model
                | expandedColumns =
                    if List.member status model.expandedColumns then
                        List.filter ((/=) status) model.expandedColumns

                    else
                        status :: model.expandedColumns
              }
            , Cmd.none
            )

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
            withSelected model
                (\projectId ->
                    let
                        outcome =
                            String.trim model.outcomeDraft
                    in
                    send IgnoreReply
                        (Command.SetDesiredOutcome projectId outcome)
                        { model
                            | detail = Maybe.map (\detail -> { detail | desiredOutcome = outcome }) model.detail
                            , outcomeEditing = False
                        }
                )

        DiaryChanged body ->
            ( { model | diaryDraft = body }, Cmd.none )

        AddDiaryEntry ->
            withSelected model
                (\projectId ->
                    if String.isEmpty (String.trim model.diaryDraft) then
                        ( model, Cmd.none )

                    else
                        send AppendDiary (Command.AddDiaryEntry projectId (String.trim model.diaryDraft)) model
                )

        SupportNoteTitleChanged noteTitle ->
            ( { model | supportNoteTitle = noteTitle }, Cmd.none )

        CreateSupportNote ->
            withSelected model
                (\projectId ->
                    if String.isEmpty (String.trim model.supportNoteTitle) then
                        ( model, Cmd.none )

                    else
                        send OpenNewSupportNote (Command.CreateSupportNote projectId (String.trim model.supportNoteTitle)) model
                )

        SupportFolderChanged path ->
            ( { model | supportFolderPath = path }, Cmd.none )

        CreateSupportFolder ->
            withSelected model
                (\projectId ->
                    if String.isEmpty (String.trim model.supportFolderPath) then
                        ( model, Cmd.none )

                    else
                        send IgnoreReply
                            (Command.CreateSupportFolder projectId (String.trim model.supportFolderPath))
                            { model | supportFolderPath = "" }
                )

        ToggleSupport file ->
            let
                nextOpen =
                    toggleSet file.path model.openSupport

                next =
                    { model | openSupport = nextOpen }
            in
            if Set.member file.path nextOpen && file.kind == SupportNote && not (Dict.member file.path model.supportBodies) then
                readSupport file.path next

            else
                ( next, Cmd.none )

        BeginSupportEdit file ->
            if Dict.member file.path model.supportBodies then
                ( { model
                    | openSupport = Set.insert file.path model.openSupport
                    , editingSupport = Just file.path
                    , supportDraft = Dict.get file.path model.supportBodies |> Maybe.withDefault ""
                  }
                , Cmd.none
                )

            else
                readSupport file.path { model | openSupport = Set.insert file.path model.openSupport, editingSupport = Just file.path }

        SupportDraftChanged body ->
            ( { model | supportDraft = body }, Cmd.none )

        CancelSupportEdit ->
            ( { model | editingSupport = Nothing }, Cmd.none )

        SaveSupportNote path ->
            withSelected model
                (\projectId ->
                    send IgnoreReply
                        (Command.UpdateSupportNote projectId path model.supportDraft)
                        { model | supportBodies = Dict.insert path model.supportDraft model.supportBodies, editingSupport = Nothing }
                )

        DragStarted projectId ->
            ( { model | draggedProject = Just projectId, subprojectDropTarget = Nothing }, Cmd.none )

        DragOver ->
            ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        DragOverSubproject status beforeId ->
            ( { model | subprojectDropTarget = Just { status = status, beforeId = beforeId } }, Cmd.none )

        DragEnded ->
            ( { model | draggedProject = Nothing, subprojectDropTarget = Nothing }, Cmd.none )

        DropProject status ->
            case model.draggedProject of
                Just projectId ->
                    send IgnoreReply
                        (if isTopLevel model projectId then
                            -- Joining a column at the end gives the Project a rank there.
                            Command.MoveSubproject projectId status Nothing

                         else
                            Command.SetProjectStatus projectId status
                        )
                        { model | draggedProject = Nothing, subprojectDropTarget = Nothing }

                Nothing ->
                    ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        DropSubproject status beforeId ->
            case model.draggedProject of
                Just projectId ->
                    send IgnoreReply
                        (Command.MoveSubproject projectId status beforeId)
                        { model | draggedProject = Nothing, subprojectDropTarget = Nothing }

                Nothing ->
                    ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


withSelected : Model -> (ProjectId -> ( Model, Cmd Msg )) -> ( Model, Cmd Msg )
withSelected model run =
    case model.selectedProjectId of
        Just projectId ->
            run projectId

        Nothing ->
            ( model, Cmd.none )


selectProject : ProjectId -> Model -> ( Model, Cmd Msg )
selectProject projectId model =
    let
        next =
            { model
                | selectedProjectId = Just projectId
                , detail = Nothing
                , showCompleted = False
                , showSecondary = False
                , detailTab = OverviewTab
                , tagFilters = Set.empty
                , outcomeEditing = False
                , editingSupport = Nothing
            }

        ( afterSelection, selectionCmd ) =
            send IgnoreReply (Command.SetProjectSelection (Just projectId)) next

        ( loaded, detailCmd ) =
            send IgnoreReply (Command.LoadProjectDetail projectId) afterSelection
    in
    ( loaded, Cmd.batch [ selectionCmd, detailCmd ] )


readSupport : String -> Model -> ( Model, Cmd Msg )
readSupport path model =
    withSelected model (\projectId -> send (ReadSupport path) (Command.ReadSupportNote projectId path) model)


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests }, projectsToHost (Host.envelope requestId (Command.encode command)) )


savePreferences : Model -> ( Model, Cmd Msg )
savePreferences model =
    send IgnoreReply (Command.SaveProjectPreferences model.visibleColumns model.showImages) model



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | ProjectMetaEvent (List ProjectMeta)
    | ProjectDetailEvent ProjectDetail
    | ShowProjectEvent (Maybe ProjectId)
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (SnapshotEvent snapshot) ->
            let
                ids =
                    Set.fromList (List.map .id snapshot.projects)

                next =
                    { model | snapshot = snapshot, selectedIds = Set.intersect ids model.selectedIds }
            in
            case next.selectedProjectId of
                Just projectId ->
                    if Set.member projectId ids then
                        send IgnoreReply (Command.LoadProjectDetail projectId) next

                    else
                        ( { next | selectedProjectId = Nothing, detail = Nothing }, Cmd.none )

                Nothing ->
                    ( next, Cmd.none )

        Ok (ProjectMetaEvent items) ->
            ( { model | meta = metaDict items }, Cmd.none )

        Ok (ProjectDetailEvent detail) ->
            if model.selectedProjectId == Just detail.projectId then
                ( { model | detail = Just detail, outcomeDraft = detail.desiredOutcome }, Cmd.none )

            else
                ( model, Cmd.none )

        Ok (ShowProjectEvent maybeId) ->
            case maybeId of
                Just projectId ->
                    selectProject projectId model

                Nothing ->
                    ( { model | selectedProjectId = Nothing, detail = Nothing }, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests
            in
            case outcome.result of
                Err message ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                Ok resultValue ->
                    finish (Maybe.withDefault IgnoreReply pending) resultValue { model | requests = requests, error = Nothing }


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending resultValue model =
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

        AppendDiary ->
            case Decode.decodeValue diaryDecoder resultValue of
                Ok entry ->
                    ( { model
                        | detail = Maybe.map (\detail -> { detail | diary = entry :: detail.diary }) model.detail
                        , diaryDraft = ""
                      }
                    , Cmd.none
                    )

                Err _ ->
                    ( model, Cmd.none )

        OpenNewSupportNote ->
            case Decode.decodeValue Decode.string resultValue of
                Ok path ->
                    withSelected model
                        (\projectId ->
                            send (ReadSupport path)
                                (Command.ReadSupportNote projectId path)
                                { model
                                    | supportNoteTitle = ""
                                    , openSupport = Set.insert path model.openSupport
                                    , editingSupport = Just path
                                }
                        )

                Err _ ->
                    ( model, Cmd.none )

        IgnoreReply ->
            ( model, Cmd.none )



-- VIEW


view : Model -> Html Msg
view model =
    case model.error of
        Just message ->
            div [ class "dg-view dg-projects-view" ] [ div [ class "dg-panel dg-error" ] [ text message ], viewBody model ]

        Nothing ->
            viewBody model


viewBody : Model -> Html Msg
viewBody model =
    case model.selectedProjectId |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects) of
        Just project ->
            viewDetail model project

        Nothing ->
            viewBoard model


viewBoard : Model -> Html Msg
viewBoard model =
    div [ class "dg-view dg-projects-view" ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 [] [ text "Projects" ]
                , span
                    [ class "dg-count"

                    ]
                    [ text (String.fromInt (List.length (visibleProjects model))) ]
                ]
            , div [ class "dg-header-actions" ]
                [ button [ onClick (Send IgnoreReply Command.OpenSomedayReview) ]
                    [ text ("Review Someday/Maybe (" ++ String.fromInt (List.length (somedayQueue model)) ++ ")") ]
                , button [ onClick (Send IgnoreReply (Command.NewActionModal Nothing)) ] [ text "New Action" ]
                , button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewProjectModal Nothing)) ] [ text "New Project" ]
                ]
            ]
        , div [ class "dg-toolbar dg-project-toolbar" ]
            [ input [ type_ "search", placeholder "Search Projects", value model.search, onInput SearchChanged ] []
            , label [ class "dg-toolbar-toggle" ]
                [ input [ type_ "checkbox", checked model.issuesOnly, onCheck ToggleIssues ] [], span [] [ text "Issues only" ] ]
            , button [ classList [ ( "is-active", model.columnsOpen ) ], onClick ToggleColumns ] [ text "Columns" ]
            , button
                [ classList [ ( "is-active", model.selecting ) ]
                , attribute "aria-pressed" (Ui.boolAttribute model.selecting)
                , onClick ToggleSelecting
                ]
                [ text "Select" ]
            , label [ class "dg-toolbar-toggle" ]
                [ input [ type_ "checkbox", checked model.showImages, onCheck ToggleImages ] [], span [] [ text "Images" ] ]
            , label [ class "dg-toolbar-toggle" ]
                [ input [ type_ "checkbox", checked model.showSubprojects, onCheck ToggleSubprojects ] [], span [] [ text "Sub-projects" ] ]
            ]
        , if model.columnsOpen then
            viewColumnPicker model

          else
            text ""
        , if model.selecting then
            viewBatchBar model

          else
            text ""
        , div [ class "dg-board dg-project-board", attribute "role" "list" ]
            (ProjectStatus.board
                |> List.filter (\status -> List.member status model.visibleColumns)
                |> List.map
                    (\status ->
                        if isSecondaryColumn status && not (List.member status model.expandedColumns) then
                            viewCollapsedColumn model status

                        else
                            viewProjectColumn model status
                    )
            )
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
                label []
                    [ input
                        [ type_ "checkbox"
                        , checked isChecked
                        , disabled (isChecked && List.length model.visibleColumns == 1)
                        , onCheck (\_ -> ToggleColumn status)
                        ]
                        []
                    , text (ProjectStatus.label status)
                    ]
            )
            ProjectStatus.board
        )


viewBatchBar : Model -> Html Msg
viewBatchBar model =
    let
        ids =
            Set.toList model.selectedIds

        none =
            List.isEmpty ids
    in
    div [ class "dg-panel dg-batch-bar", attribute "role" "toolbar" ]
        [ span [ class "dg-batch-count" ] [ strong [] [ text (String.fromInt (List.length ids)) ], text " selected" ]
        , button [ disabled none, onClick (Send IgnoreReply (Command.BatchProjectTagsModal ids)) ] [ text "Add tag…" ]
        , button [ disabled none, onClick (Send IgnoreReply (Command.BatchProjectParentModal ids)) ] [ text "Set parent…" ]
        , button [ class "dg-batch-delete", disabled none, onClick (Send IgnoreReply (Command.TrashProjects ids)) ] [ text "Delete…" ]
        , span [ class "dg-batch-spacer" ] []
        , button [ onClick SelectAll ] [ text "Select all shown" ]
        , button [ disabled none, onClick ClearSelection ] [ text "Clear" ]
        ]


{-| Someday/Maybe and Completed hold no committed work, so the board keeps them
out of the way until asked.
-}
isSecondaryColumn : ProjectStatus -> Bool
isSecondaryColumn status =
    status == ProjectStatus.Someday || status == ProjectStatus.Completed


viewCollapsedColumn : Model -> ProjectStatus -> Html Msg
viewCollapsedColumn model status =
    let
        count =
            visibleProjects model |> List.filter (\project -> project.status == status) |> List.length
    in
    section
        [ class "dg-column dg-project-column is-collapsed"
        , attribute "data-column" (ProjectStatus.key status)
        , dragOver
        , on "drop" (Decode.succeed (DropProject status))
        ]
        [ button
            [ class "dg-project-column-expand dg-flat-button"

            , attribute "aria-expanded" "false"
            , onClick (ToggleColumnExpanded status)
            ]
            [ span [] [ text (disclosure False) ]
            , span [ class "dg-project-column-expand-label" ] [ text (ProjectStatus.label status) ]
            , span [ class "dg-project-column-expand-count" ] [ text (String.fromInt count) ]
            ]
        ]


viewProjectColumn : Model -> ProjectStatus -> Html Msg
viewProjectColumn model status =
    let
        projects =
            visibleProjects model
                |> List.filter (\project -> project.status == status)
                |> ranked

        issues =
            projects |> List.filter (\project -> (projectMeta project.id model).actionIssue /= Nothing) |> List.length
    in
    section
        [ class "dg-column dg-project-column"
        , attribute "data-column" (ProjectStatus.key status)
        , dragOver
        , on "drop" (Decode.succeed (DropProject status))
        ]
        [ header [ class "dg-column-header" ]
            [ if isSecondaryColumn status then
                button
                    [ class "dg-project-column-collapse dg-flat-button"

                    , attribute "aria-expanded" "true"
                    , onClick (ToggleColumnExpanded status)
                    ]
                    [ text (disclosure True ++ " " ++ ProjectStatus.label status) ]

              else
                span [] [ text (ProjectStatus.label status) ]
            , span [ class "dg-project-column-counts" ]
                (text (String.fromInt (List.length projects) ++ " Projects")
                    :: (if status == ProjectStatus.Active then
                            [ span [ class "dg-project-column-health" ]
                                [ text (String.fromInt issues ++ " issues") ]
                            ]

                        else
                            []
                       )
                )
            ]
        , div [ class "dg-card-list" ]
            (if List.isEmpty projects then
                [ div [ class "dg-empty-row" ] [ text ("No " ++ String.toLower (ProjectStatus.label status) ++ " Projects.") ] ]

             else
                List.map (viewProjectCard model) projects
            )
        ]


viewProjectCard : Model -> Project -> Html Msg
viewProjectCard model project =
    let
        meta =
            projectMeta project.id model

        openCount =
            projectActions model project |> List.filter (\action -> ActionStatus.isOpen action.status) |> List.length

        selected =
            Set.member project.id model.selectedIds
    in
    article
        ([ classList
            [ ( "dg-card dg-project-card", True )
            , ( "is-selectable", model.selecting )
            , ( "is-selected", selected )
            , ( "is-drop-before", model.subprojectDropTarget == Just { status = project.status, beforeId = Just project.id } )
            ]
         , attribute "data-project-card" project.id
         , draggable (Ui.boolAttribute (not model.selecting))
         , on "dragstart" (Decode.succeed (DragStarted project.id))
         , on "dragend" (Decode.succeed DragEnded)
         , onClick
            (if model.selecting then
                ToggleSelected project.id

             else
                NoOp
            )
         ]
            ++ rankDropAttributes model project
        )
        [ if model.showImages && not (String.isEmpty meta.imageUrl) then
            div [ class "dg-project-card-image" ] [ img [ src meta.imageUrl, alt "" ] [] ]

          else
            text ""
        , div [ class "dg-card-title-row" ]
            [ if model.selecting then
                input [ class "dg-batch-checkbox", type_ "checkbox", checked selected ] []

              else
                text ""
            , button
                [ class "dg-card-title dg-flat-button"

                , onClick
                    (if model.selecting then
                        NoOp

                     else
                        SelectProject project.id
                    )
                ]
                [ text project.title ]
            , button
                [ class "dg-icon-button dg-flat-button"
                , Ui.onPointer (\x y -> Send IgnoreReply (projectMenu x y model project))
                ]
                (Ui.iconLabel "•••" ("Actions for " ++ project.title))
            ]
        , if meta.breadcrumb /= project.title then
            div [ class "dg-project-lineage" ] [ text meta.breadcrumb ]

          else
            text ""
        , Ui.maybeView project.area (\area -> div [ class "dg-project-area" ] [ text area ])
        , div [ class "dg-project-tags" ] (List.map viewTag project.tags)
        , div [ class "dg-project-metrics" ]
            [ span [] [ strong [] [ text (String.fromInt openCount) ], text " open" ]
            , span [] [ strong [] [ text (String.fromInt meta.activeSubprojects) ], text " sub" ]
            , span [] [ strong [] [ text (String.fromInt meta.supportFiles) ], text " files" ]
            ]
        , Ui.maybeView project.reviewed (\reviewed -> div [ class "dg-project-reviewed" ] [ text ("Reviewed " ++ reviewed) ])
        , if project.status == ProjectStatus.Someday then
            Ui.maybeView project.activateAt (\date -> div [ class "dg-project-reviewed" ] [ text ("Activates " ++ date) ])

          else
            text ""
        , Ui.maybeView meta.actionIssue (\issue -> div [ class "dg-project-health" ] [ text issue ])
        ]


{-| A top-level card accepts another top-level Project dropped before it, which
ranks its column. Sub-projects are ranked on their parent's board instead.
-}
rankDropAttributes : Model -> Project -> List (Html.Attribute Msg)
rankDropAttributes model project =
    let
        draggingTopLevel =
            model.draggedProject |> Maybe.map (isTopLevel model) |> Maybe.withDefault False
    in
    if project.parentProjectId == Nothing && draggingTopLevel then
        [ Html.Events.custom "dragover"
            (Decode.succeed { message = DragOverSubproject project.status (Just project.id), stopPropagation = True, preventDefault = True })
        , Html.Events.custom "drop"
            (Decode.succeed { message = DropSubproject project.status (Just project.id), stopPropagation = True, preventDefault = True })
        ]

    else
        []


viewTag : String -> Html Msg
viewTag tag =
    span [] [ text ("#" ++ tag) ]


viewDetail : Model -> Project -> Html Msg
viewDetail model project =
    let
        meta =
            projectMeta project.id model

        parent =
            project.parentProjectId |> Maybe.andThen (\parentId -> Data.findProject parentId model.snapshot.projects)

        imageUrl =
            meta.imageUrl

        actions =
            projectActions model project

        openActions =
            List.filter (\action -> ActionStatus.isOpen action.status) actions

        completedActions =
            List.filter (\action -> action.status == ActionStatus.Done) actions
    in
    div [ class "dg-view dg-project-detail" ]
        [ header [ class "dg-view-header" ]
            [ div [ class "dg-detail-heading" ]
                [ Ui.maybeView parent (\item -> button [ class "dg-parent-back", onClick (SelectProject item.id) ] [ text ("← " ++ item.title) ])
                , button [ onClick BackToBoard ] [ text "← Projects" ]
                , h2 [] [ text project.title ]
                , span [ class ("dg-status dg-status-" ++ ProjectStatus.key project.status) ] [ text (ProjectStatus.label project.status) ]
                ]
            , div [ class "dg-header-actions" ]
                [ button [ onClick (Send IgnoreReply (Command.OpenPomodoro project.id)) ] [ text "Start Pomodoro" ]
                , button [ onClick (Send IgnoreReply (Command.OpenFile project.file.path)) ] [ text "Open note" ]
                , button [ onClick (Send IgnoreReply (Command.EditProjectModal project.id)) ] [ text "Edit" ]
                ]
            ]
        , Ui.maybeView meta.actionIssue
            (\issue -> div [ class "dg-warning" ] [ text ("Action issue: " ++ issue) ])
        , viewDetailTabs model project openActions
        , main_ [ class "dg-project-detail-content", attribute "role" "tabpanel" ]
            (case model.detailTab of
                OverviewTab ->
                    [ if String.isEmpty imageUrl then
                        text ""

                      else
                        div [ class "dg-project-main-image" ] [ img [ src imageUrl, alt ("Main image for " ++ project.title) ] [] ]
                    , viewOutcome model project
                    , viewActionsSection model project openActions completedActions
                    ]

                SubprojectsTab ->
                    [ viewSubprojects model project ]

                DiaryTab ->
                    [ viewDiary model ]

                FilesTab ->
                    [ viewSupport model ]
            )
        ]


viewDetailTabs : Model -> Project -> List Action -> Html Msg
viewDetailTabs model project openActions =
    let
        childCount =
            List.filter (\child -> child.parentProjectId == Just project.id) model.snapshot.projects |> List.length

        diaryCount =
            Maybe.map (.diary >> List.length) model.detail

        fileCount =
            Maybe.map (.supportFiles >> List.length) model.detail

        tab target label count =
            button
                [ classList [ ( "dg-detail-tab dg-flat-button", True ), ( "is-active", model.detailTab == target ) ]
                , attribute "role" "tab"
                , attribute "aria-selected" (Ui.boolAttribute (model.detailTab == target))
                , onClick (SelectTab target)
                ]
                (text label
                    :: Ui.maybeList count (\n -> span [ class "dg-detail-tab-count" ] [ text (String.fromInt n) ])
                )
    in
    div [ class "dg-detail-tabs", attribute "role" "tablist" ]
        [ tab OverviewTab "Overview" (Just (List.length openActions))
        , tab SubprojectsTab "Sub-projects" (Just childCount)
        , tab DiaryTab "Diary" diaryCount
        , tab FilesTab "Files" fileCount
        ]




viewOutcome : Model -> Project -> Html Msg
viewOutcome model project =
    let
        outcome =
            Maybe.map .desiredOutcome model.detail |> Maybe.withDefault ""
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
                [ textarea
                    [ class "dg-outcome-input"
                    , value model.outcomeDraft
                    , rows 5
                    , placeholder ("What will be true when this Project is complete? (" ++ saveChord model ++ " to save)")
                    , onInput OutcomeChanged
                    , Ui.onModEnter { save = SaveOutcome, ignore = NoOp }
                    ]
                    []
                , div [ class "dg-outcome-edit-actions" ]
                    [ button [ onClick CancelOutcome ] [ text "Cancel" ]
                    , button [ class "mod-cta", onClick SaveOutcome ] [ text "Save outcome" ]
                    ]
                ]

          else if String.isEmpty outcome then
            div [ class "dg-detail-empty" ] [ text "No desired outcome written yet." ]

          else
            markdownView outcome project.file.path
        ]


saveChord : Model -> String
saveChord model =
    if model.isMac then
        "⌘+Enter"

    else
        "Ctrl+Enter"


viewActionsSection : Model -> Project -> List Action -> List Action -> Html Msg
viewActionsSection model project openActions completedActions =
    div []
        [ section [ class "dg-detail-section dg-project-actions-panel" ]
            [ div [ class "dg-detail-section-heading" ]
                [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Work" ], h3 [] [ text "Open Actions" ] ]
                , div [ class "dg-detail-section-actions" ]
                    [ span [ class "dg-detail-count" ] [ text (String.fromInt (List.length openActions)) ]
                    , button [ onClick (Send IgnoreReply (Command.ImportActionsModal project.id)) ] [ text "Import…" ]
                    , button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewActionModal (Just project.id))) ] [ text "New Action" ]
                    ]
                ]
            , viewActionRows openActions
            ]
        , if List.isEmpty completedActions then
            text ""

          else
            section [ class "dg-detail-section dg-completed-actions-panel" ]
                [ button [ class "dg-disclosure dg-flat-button", onClick ToggleCompleted ]
                    [ span [] [ text (disclosure model.showCompleted ++ " Completed Actions") ]
                    , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length completedActions)) ]
                    ]
                , if model.showCompleted then
                    viewActionRows completedActions

                  else
                    text ""
                ]
        ]


disclosure : Bool -> String
disclosure open =
    if open then
        "▾"

    else
        "▸"


viewActionRows : List Action -> Html Msg
viewActionRows actions =
    if List.isEmpty actions then
        div [ class "dg-detail-empty" ] [ text "No Actions." ]

    else
        div [ class "dg-action-rows" ] (List.map viewActionRow actions)


viewActionRow : Action -> Html Msg
viewActionRow action =
    let
        done =
            action.status == ActionStatus.Done
    in
    article [ class "dg-action-row" ]
        [ Ui.labelled
            ((if done then
                "Reopen "

              else
                "Complete "
             )
                ++ action.title
            )
            (input
                [ class "dg-action-row-checkbox"
                , type_ "checkbox"
                , checked done
                , onCheck (\checkedNow -> Send IgnoreReply (Command.SetActionStatus action.id (completionStatus checkedNow)))
                ]
                []
            )
        , div [ class "dg-action-row-main" ]
            [ span [ class "dg-action-row-title" ] [ text action.title ]
            , div [ class "dg-action-row-meta" ]
                ((if action.status == ActionStatus.Next then
                    []

                  else
                    [ span [ class ("dg-action-status dg-action-status-" ++ ActionStatus.key action.status) ]
                        [ text (ActionStatus.label action.status) ]
                    ]
                 )
                    ++ Ui.maybeList action.context (\context -> span [] [ text ("@" ++ context) ])
                    ++ Ui.maybeList action.due (\due -> span [] [ text ("Due " ++ due) ])
                )
            ]
        , div [ class "dg-action-row-actions" ]
            [ button [ class "dg-action-row-edit dg-flat-button", onClick (Send IgnoreReply (Command.EditActionModal action.id)) ] [ text "Edit" ]
            , button [ class "dg-action-row-delete dg-flat-button", onClick (Send IgnoreReply (Command.TrashAction action.id)) ] [ text "Delete" ]
            ]
        ]


completionStatus : Bool -> ActionStatus.ActionStatus
completionStatus done =
    if done then
        ActionStatus.Done

    else
        ActionStatus.Next


viewSubprojects : Model -> Project -> Html Msg
viewSubprojects model project =
    let
        children =
            List.filter (\child -> child.parentProjectId == Just project.id) model.snapshot.projects
                |> List.sortWith Hierarchy.compareByOrder

        tags =
            children |> List.concatMap .tags |> Ui.uniqueSorted

        visible =
            if Set.isEmpty model.tagFilters then
                children

            else
                List.filter (\child -> Set.toList model.tagFilters |> List.all (\tag -> List.member tag child.tags)) children

        primary =
            List.filter (\child -> List.member child.status [ ProjectStatus.Active, ProjectStatus.Backlog ]) visible

        secondary =
            List.filter (\child -> List.member child.status [ ProjectStatus.Someday, ProjectStatus.Completed ]) visible
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
                , button [ onClick (Send IgnoreReply (Command.ImportSubprojectsModal project.id)) ] [ text "Import…" ]
                , button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewProjectModal (Just project.id))) ] [ text "New sub-project" ]
                ]
            ]
        , if List.isEmpty tags then
            text ""

          else
            div [ class "dg-subproject-toolbar" ]
                (span [] [ text "Filter by tag" ]
                    :: List.map
                        (\tag ->
                            button [ classList [ ( "is-active", Set.member tag model.tagFilters ) ], onClick (ToggleTag tag) ]
                                [ text ("#" ++ tag) ]
                        )
                        tags
                    ++ (if Set.isEmpty model.tagFilters then
                            []

                        else
                            [ button [ onClick ClearTags ] [ text "Clear" ] ]
                       )
                )
        , div [ class "dg-subproject-columns dg-subproject-columns-primary" ]
            (List.map (viewSubprojectColumn model primary) [ ProjectStatus.Active, ProjectStatus.Backlog ])
        , div [ classList [ ( "dg-subproject-secondary", True ), ( "is-open", model.showSecondary ) ] ]
            [ button [ class "dg-disclosure dg-subproject-secondary-toggle dg-flat-button", onClick ToggleSecondary ]
                [ span [] [ text (disclosure model.showSecondary ++ " Someday/Maybe and Completed") ]
                , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length secondary)) ]
                ]
            , if model.showSecondary then
                div [ class "dg-subproject-columns dg-subproject-columns-secondary" ]
                    (List.map (viewSubprojectColumn model secondary) [ ProjectStatus.Someday, ProjectStatus.Completed ])

              else
                text ""
            ]
        ]


viewSubprojectColumn : Model -> List Project -> ProjectStatus -> Html Msg
viewSubprojectColumn model projects status =
    let
        items =
            List.filter (\project -> project.status == status) projects
    in
    div
        [ class "dg-subproject-column"
        , attribute "data-subproject-column" (ProjectStatus.key status)
        , Ui.preventDefaultOn "dragover" (DragOverSubproject status Nothing)
        , on "drop" (Decode.succeed (DropSubproject status Nothing))
        ]
        [ header [] [ strong [] [ text (ProjectStatus.label status) ], span [] [ text (String.fromInt (List.length items)) ] ]
        , div [ class "dg-subproject-list" ]
            (List.map (viewSubprojectCard model) items
                ++ (if model.subprojectDropTarget == Just { status = status, beforeId = Nothing } then
                        [ div [ class "dg-subproject-drop-line", attribute "aria-hidden" "true" ] [] ]

                    else
                        []
                   )
                ++ (if List.isEmpty items then
                        [ div [ class "dg-subproject-empty" ] [ text ("No " ++ String.toLower (ProjectStatus.label status) ++ " sub-projects.") ] ]

                    else
                        []
                   )
            )
        ]


viewSubprojectCard : Model -> Project -> Html Msg
viewSubprojectCard model project =
    let
        blockers =
            (projectMeta project.id model).blockers
    in
    article
        [ classList
            [ ( "dg-subproject-card", True )
            , ( "is-blocked", not (List.isEmpty blockers) )
            , ( "is-drop-before", model.subprojectDropTarget == Just { status = project.status, beforeId = Just project.id } )
            ]
        , draggable "true"
        , on "dragstart" (Decode.succeed (DragStarted project.id))
        , on "dragend" (Decode.succeed DragEnded)
        , Html.Events.custom "dragover"
            (Decode.succeed
                { message = DragOverSubproject project.status (Just project.id)
                , stopPropagation = True
                , preventDefault = True
                }
            )
        , Html.Events.custom "drop"
            (Decode.succeed { message = DropSubproject project.status (Just project.id), stopPropagation = True, preventDefault = True })
        ]
        [ div [ class "dg-subproject-card-heading" ]
            [ button [ class "dg-subproject-title dg-flat-button", onClick (SelectProject project.id) ] [ text project.title ]
            , button
                [ class "dg-icon-button dg-flat-button"
                , Ui.onPointer (\x y -> Send IgnoreReply (subprojectMenu x y model project))
                ]
                (Ui.iconLabel "•••" ("Actions for " ++ project.title))
            ]
        , if List.isEmpty project.tags then
            text ""

          else
            div [ class "dg-project-tags" ] (List.map viewTag project.tags)
        , if List.isEmpty blockers then
            text ""

          else
            div [ class "dg-subproject-blocked" ]
                [ text
                    ("Blocked by "
                        ++ (case blockers of
                                [ only ] ->
                                    only

                                _ ->
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
    in
    section [ class "dg-detail-section dg-project-diary-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Log" ], h3 [] [ text "Diary" ] ]
            , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length entries)) ]
            ]
        , div [ class "dg-diary-add" ]
            [ textarea
                [ value model.diaryDraft
                , rows 3
                , placeholder ("Observation or decision… (" ++ saveChord model ++ " to add)")
                , onInput DiaryChanged
                , Ui.onModEnter { save = AddDiaryEntry, ignore = NoOp }
                ]
                []
            , button [ class "mod-cta", disabled (String.isEmpty (String.trim model.diaryDraft)), onClick AddDiaryEntry ] [ text "Add entry" ]
            ]
        , div [ class "dg-diary-list" ]
            (if model.detail == Nothing then
                [ span [ class "dg-muted" ] [ text "Loading…" ] ]

             else if List.isEmpty entries then
                [ span [ class "dg-muted" ] [ text "No entries yet." ] ]

             else
                List.map (\entry -> div [] [ span [] [ text entry.timestamp ], p [] [ text entry.body ] ]) entries
            )
        ]


viewSupport : Model -> Html Msg
viewSupport model =
    let
        files =
            Maybe.map .supportFiles model.detail |> Maybe.withDefault []

        folders =
            Maybe.map .supportFolders model.detail |> Maybe.withDefault []

        readable =
            List.filter (\file -> file.kind /= SupportAttachment) files

        attachments =
            List.filter (\file -> file.kind == SupportAttachment) files
    in
    section [ class "dg-detail-section dg-support-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div [] [ span [ class "dg-detail-eyebrow" ] [ text "Files" ], h3 [] [ text "Project Support Material" ] ]
            , span [ class "dg-detail-count" ]
                [ text (String.fromInt (List.length files) ++ " files · " ++ String.fromInt (List.length folders) ++ " folders") ]
            ]
        , div [ class "dg-support-create" ]
            [ div [ class "dg-support-note-create" ]
                [ input [ value model.supportNoteTitle, placeholder "Note title…", onInput SupportNoteTitleChanged ] []
                , button [ class "mod-cta", disabled (String.isEmpty (String.trim model.supportNoteTitle)), onClick CreateSupportNote ] [ text "Create note" ]
                ]
            , div [ class "dg-support-folder-create" ]
                [ input [ value model.supportFolderPath, placeholder "Folder name or path…", onInput SupportFolderChanged ] []
                , button [ disabled (String.isEmpty (String.trim model.supportFolderPath)), onClick CreateSupportFolder ] [ text "Create folder" ]
                ]
            ]
        , if List.isEmpty folders then
            text ""

          else
            div [ class "dg-support-folders" ]
                [ span [] [ text "Folders" ]
                , div [] (List.map (\folder -> span [] [ text ("📁 " ++ folder.label) ]) folders)
                ]
        , div [ class "dg-support-notes" ] (List.map (viewSupportFile model) readable)
        , if List.isEmpty attachments then
            text ""

          else
            div [ class "dg-support-attachments" ]
                [ span [] [ text "Other files" ]
                , div []
                    (List.map
                        (\file -> button [ class "dg-flat-button", onClick (Send IgnoreReply (Command.OpenFile file.path)) ] [ text file.label ])
                        attachments
                    )
                ]
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
    in
    article [ classList [ ( "dg-support-note", True ), ( "dg-support-image", file.kind == SupportImage ), ( "is-open", open ) ] ]
        [ header []
            [ button
                [ class "dg-support-note-toggle dg-flat-button"
                , onClick (ToggleSupport file)
                , attribute "aria-expanded" (Ui.boolAttribute open)
                ]
                [ span [] [ text (disclosure open) ], span [] [ text file.label ] ]
            , div []
                (button [ class "dg-flat-button", onClick (Send IgnoreReply (Command.OpenFile file.path)) ] [ text "Open" ]
                    :: (if file.kind == SupportNote then
                            [ button [ class "dg-flat-button", onClick (BeginSupportEdit file) ] [ text "Edit" ] ]

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
                    (if file.kind == SupportImage then
                        "dg-support-note-body dg-support-image-body"

                     else
                        "dg-support-note-body"
                    )
                ]
                [ viewSupportBody model file editing ]
        ]


viewSupportBody : Model -> SupportFile -> Bool -> Html Msg
viewSupportBody model file editing =
    if file.kind == SupportImage then
        img [ src file.resourceUrl, alt file.label ] []

    else if editing then
        div []
            [ textarea [ value model.supportDraft, onInput SupportDraftChanged ] []
            , div [ class "dg-support-note-edit-actions" ]
                [ button [ onClick CancelSupportEdit ] [ text "Cancel" ]
                , button [ class "mod-cta", onClick (SaveSupportNote file.path) ] [ text "Save note" ]
                ]
            ]

    else
        case Dict.get file.path model.supportBodies of
            Just content ->
                if String.isEmpty content then
                    span [ class "dg-muted" ] [ text "This note is empty." ]

                else
                    markdownView content file.path

            Nothing ->
                span [ class "dg-muted" ] [ text "Loading…" ]


markdownView : String -> String -> Html Msg
markdownView markdown sourcePath =
    node "dg-markdown"
        [ class "dg-outcome markdown-rendered"
        , attribute "data-markdown" markdown
        , attribute "data-source-path" sourcePath
        ]
        []


dragOver : Html.Attribute Msg
dragOver =
    Ui.preventDefaultOn "dragover" DragOver



-- MENUS


projectMenu : Float -> Float -> Model -> Project -> Command
projectMenu x y model project =
    Command.ShowMenu x
        y
        (statusEntries project (\status -> Command.SetProjectStatus project.id status)
            ++ (if project.parentProjectId == Nothing then
                    MenuSeparator :: rankEntries model project

                else
                    []
               )
            ++ [ MenuSeparator
               , MenuItem "Start Pomodoro…" (Command.OpenPomodoro project.id)
               , MenuItem "New Action…" (Command.NewActionModal (Just project.id))
               , MenuItem "New sub-project…" (Command.NewProjectModal (Just project.id))
               , MenuItem "Open note" (Command.OpenFile project.file.path)
               , MenuItem "Edit…" (Command.EditProjectModal project.id)
               , MenuSeparator
               , MenuItem "Delete Project…" (Command.TrashProject project.id)
               ]
        )


{-| Move up and Move down among the Projects sharing this one's parent and status,
the keyboard-friendly twin of dragging a card.
-}
rankEntries : Model -> Project -> List MenuEntry
rankEntries model project =
    let
        siblings =
            model.snapshot.projects
                |> List.filter (\candidate -> candidate.parentProjectId == project.parentProjectId && candidate.status == project.status)
                |> List.sortWith Hierarchy.compareByOrder
    in
    case indexOf project.id siblings of
        Nothing ->
            []

        Just position ->
            Ui.maybeList (itemAt (position - 1) siblings)
                (\before -> MenuItem "Move up" (Command.MoveSubproject project.id project.status (Just before.id)))
                ++ (if position < List.length siblings - 1 then
                        [ MenuItem "Move down"
                            (Command.MoveSubproject project.id project.status (itemAt (position + 2) siblings |> Maybe.map .id))
                        ]

                    else
                        []
                   )


subprojectMenu : Float -> Float -> Model -> Project -> Command
subprojectMenu x y model project =
    Command.ShowMenu x
        y
        (statusEntries project (\status -> Command.MoveSubproject project.id status Nothing)
            ++ [ MenuSeparator ]
            ++ rankEntries model project
            ++ [ MenuSeparator
               , MenuItem "Blocked by…" (Command.ProjectDependenciesModal project.id)
               , MenuItem "Edit…" (Command.EditProjectModal project.id)
               , MenuItem "Open note" (Command.OpenFile project.file.path)
               , MenuItem "Start Pomodoro…" (Command.OpenPomodoro project.id)
               , MenuItem "New Action…" (Command.NewActionModal (Just project.id))
               , MenuItem "New sub-project…" (Command.NewProjectModal (Just project.id))
               , MenuSeparator
               , MenuItem "Delete Project…" (Command.TrashProject project.id)
               ]
        )


statusEntries : Project -> (ProjectStatus -> Command) -> List MenuEntry
statusEntries project toCommand =
    List.map
        (\status ->
            MenuItem
                ((if project.status == status then
                    "✓ "

                  else
                    ""
                 )
                    ++ ProjectStatus.label status
                )
                (toCommand status)
        )
        ProjectStatus.board



-- QUERIES


visibleProjects : Model -> List Project
visibleProjects model =
    let
        matches project =
            let
                meta =
                    projectMeta project.id model
            in
            Ui.matches model.search [ project.title, meta.breadcrumb, Maybe.withDefault "" project.area ]
                && (not model.issuesOnly || meta.actionIssue /= Nothing)
                && (model.showSubprojects || project.parentProjectId == Nothing)
                && List.member project.status model.visibleColumns
    in
    model.snapshot.projects
        |> List.filter matches
        |> List.sortBy (\project -> String.toLower (projectMeta project.id model).breadcrumb)


{-| Someday/Maybe Projects still waiting for a decision today: the ones never
reviewed first, then the longest since their last review.
-}
somedayQueue : Model -> List Project
somedayQueue model =
    model.snapshot.projects
        |> List.filter (\project -> project.status == ProjectStatus.Someday && project.reviewed /= Just model.snapshot.today)
        |> List.sortBy (\project -> ( Maybe.withDefault "" project.reviewed, String.toLower (projectMeta project.id model).breadcrumb ))


{-| Top-level Projects in their ranked order, then any sub-projects shown
alongside them, which keep the board's usual order.
-}
ranked : List Project -> List Project
ranked projects =
    let
        ( topLevel, nested ) =
            List.partition (\project -> project.parentProjectId == Nothing) projects
    in
    List.sortWith Hierarchy.compareByOrder topLevel ++ nested


isTopLevel : Model -> ProjectId -> Bool
isTopLevel model projectId =
    Data.findProject projectId model.snapshot.projects
        |> Maybe.map (\project -> project.parentProjectId == Nothing)
        |> Maybe.withDefault False


projectActions : Model -> Project -> List Action
projectActions model project =
    List.filter (\action -> action.projectId == Just project.id) model.snapshot.actions


projectMeta : ProjectId -> Model -> ProjectMeta
projectMeta projectId model =
    Dict.get projectId model.meta
        |> Maybe.withDefault
            { id = projectId
            , breadcrumb = ""
            , activeSubprojects = 0
            , supportFiles = 0
            , imageUrl = ""
            , actionIssue = Nothing
            , blockers = []
            }


toggleSet : comparable -> Set comparable -> Set comparable
toggleSet item items =
    if Set.member item items then
        Set.remove item items

    else
        Set.insert item items


indexOf : ProjectId -> List Project -> Maybe Int
indexOf projectId projects =
    projects
        |> List.indexedMap Tuple.pair
        |> List.filter (\( _, project ) -> project.id == projectId)
        |> List.head
        |> Maybe.map Tuple.first


itemAt : Int -> List a -> Maybe a
itemAt index items =
    if index < 0 then
        Nothing

    else
        List.drop index items |> List.head



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map4 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "projectMeta" (Decode.list projectMetaDecoder))
        (Decode.field "initialProjectId" (Decode.maybe Decode.string))
        (Decode.field "isMac" Decode.bool)


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
    Decode.map2 DiaryEntry
        (Decode.oneOf [ Decode.field "timestamp" Decode.string, Decode.succeed "" ])
        (Decode.field "text" Decode.string)


supportKindDecoder : Decoder SupportKind
supportKindDecoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case raw of
                    "note" ->
                        Decode.succeed SupportNote

                    "image" ->
                        Decode.succeed SupportImage

                    "attachment" ->
                        Decode.succeed SupportAttachment

                    _ ->
                        Decode.fail ("Unknown support file kind: " ++ raw)
            )


supportFileDecoder : Decoder SupportFile
supportFileDecoder =
    Decode.map4 SupportFile
        (Decode.field "path" Decode.string)
        (Decode.field "label" Decode.string)
        (Decode.field "kind" supportKindDecoder)
        (Decode.field "resourceUrl" Decode.string)


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
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "project-meta" ->
                        Decode.map ProjectMetaEvent (Decode.field "projectMeta" (Decode.list projectMetaDecoder))

                    "project-detail" ->
                        Decode.map ProjectDetailEvent (Decode.field "detail" projectDetailDecoder)

                    "show-project" ->
                        Decode.map ShowProjectEvent (Decode.field "projectId" (Decode.maybe Decode.string))

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


emptyModel : String -> Model
emptyModel message =
    { snapshot = Data.empty
    , meta = Dict.empty
    , selectedProjectId = Nothing
    , detail = Nothing
    , search = ""
    , issuesOnly = False
    , showSubprojects = False
    , showImages = False
    , visibleColumns = ProjectStatus.board
    , columnsOpen = False
    , selecting = False
    , selectedIds = Set.empty
    , showCompleted = False
    , showSecondary = False
    , detailTab = OverviewTab
    , expandedColumns = []
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
    , subprojectDropTarget = Nothing
    , requests = Host.noRequests
    , error = Just message
    , isMac = False
    }
