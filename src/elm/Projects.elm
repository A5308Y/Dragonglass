port module Projects exposing (main)

import Browser
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.Projects as Command exposing (Command, MenuEntry(..))
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Energy as Energy
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.Links as Links
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Ranking as Ranking
import Gtd.Settings exposing (ProjectColumnsBy(..), ProjectSections(..))
import Gtd.Support as Support
import Gtd.Ui as Ui
import Html exposing (Html, article, button, div, h2, h3, header, img, input, label, main_, node, option, p, section, select, small, span, strong, text, textarea)
import Html.Attributes exposing (alt, attribute, checked, class, classList, disabled, draggable, placeholder, rows, selected, src, tabindex, title, type_, value)
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


type alias ProjectDetail =
    { projectId : ProjectId
    , desiredOutcome : String
    , diary : List DiaryEntry
    , material : Support.Material
    }


{-| The parts of Project detail, one shown at a time so a large Project does not
become one long scroll: the work itself, and everything that supports it.
-}
type DetailTab
    = OverviewTab
    | SupportTab


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
    | MoveProjects (List ProjectId)
    | AnswerSent String


{-| A drop already shown on the board while the host writes it. `order` is left
alone when only the status changes; `confirmed` means the host has answered, so
the next snapshot is authoritative whether or not it matches.
-}
type alias PendingMove =
    { status : ProjectStatus, order : Maybe Int, confirmed : Bool }


type alias Model =
    { snapshot : Snapshot
    , hostSnapshot : Snapshot
    , pendingMoves : Dict ProjectId PendingMove
    , meta : Dict ProjectId ProjectMeta
    , selectedProjectId : Maybe ProjectId
    , detail : Maybe ProjectDetail
    , search : String
    , issuesOnly : Bool
    , showSubprojects : Bool
    , showImages : Bool
    , columnsBy : ProjectColumnsBy
    , sections : ProjectSections
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
    , showAllDiary : Bool
    , support : Support.State
    , draggedProject : Maybe ProjectId
    , subprojectDropTarget : Maybe SubprojectDropTarget
    , agent : AgentState
    , agentAnswers : Dict String String
    , requests : Requests Pending
    , error : Maybe String
    , isMac : Bool
    }


{-| Agent runs and their costs, from the host; see `src/agent/agent-service.ts`.
-}
type alias AgentState =
    { available : Bool
    , runs : List AgentRun
    , costs : Dict ProjectId { own : Float, tree : Float }
    }


type alias AgentRun =
    { id : String
    , projectId : ProjectId
    , createdAt : String
    , status : String
    , statusText : String
    , costUsd : Maybe Float
    , budgetUsd : Float
    , runtime : String
    , harness : String
    , model : String
    , offline : Bool
    , wholeVault : Bool
    , reportPath : String
    , questions : List AgentQuestion
    , activity : List AgentActivity
    , repository : String
    , branch : String
    , pullRequestUrl : String
    , previewUrl : String
    }


{-| One line of what the agent did: "thought", "text" or "tool". Newest first.
-}
type alias AgentActivity =
    { at : String, kind : String, text : String }


type alias AgentQuestion =
    { id : String, question : String, askedAt : String }


emptyAgent : AgentState
emptyAgent =
    { available = False, runs = [], costs = Dict.empty }


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
    | SetColumnsBy ProjectColumnsBy
    | SetSections ProjectSections
    | DropOnArea (Maybe String)
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
    | AgentAnswerChanged String String
    | SendAgentAnswer String String
    | ToggleAllDiary
    | AddDiaryEntry
    | SupportMsg Support.Msg
    | DragStarted ProjectId
    | DragOver
    | DragOverSubproject ProjectStatus (Maybe ProjectId)
    | DragEnded
    | DropProject ProjectStatus
    | DropSubproject ProjectStatus (Maybe ProjectId)
    | ToggleSubprojectDone ProjectId Bool
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
                    , hostSnapshot = decoded.snapshot
                    , pendingMoves = Dict.empty
                    , meta = metaDict decoded.projectMeta
                    , selectedProjectId = decoded.initialProjectId
                    , detail = Nothing
                    , search = ""
                    , issuesOnly = False
                    , showSubprojects = False
                    , showImages = decoded.snapshot.settings.showProjectBoardImages
                    , columnsBy = decoded.snapshot.settings.projectBoardColumnsBy
                    , sections = decoded.snapshot.settings.projectBoardSections
                    , visibleColumns =
                        if List.isEmpty columns then
                            ProjectStatus.defaultColumns

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
                    , showAllDiary = False
                    , support = Support.init
                    , draggedProject = Nothing
                    , subprojectDropTarget = Nothing
                    , agent = emptyAgent
                    , agentAnswers = Dict.empty
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

        SetColumnsBy columnsBy ->
            -- A column is never split by the field it already is.
            savePreferences
                { model
                    | columnsBy = columnsBy
                    , sections =
                        case ( columnsBy, model.sections ) of
                            ( ColumnsByArea, SectionsByArea ) ->
                                SectionsByStatus

                            ( ColumnsByStatus, SectionsByStatus ) ->
                                SectionsByArea

                            ( _, sections ) ->
                                sections
                }

        SetSections sections ->
            savePreferences { model | sections = sections }

        DropOnArea area ->
            case model.draggedProject |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects) of
                Just project ->
                    let
                        dropped =
                            { model | draggedProject = Nothing, subprojectDropTarget = Nothing }
                    in
                    if project.parentProjectId /= Nothing then
                        -- Sub-projects share their top-level Project's area.
                        ( { dropped | error = Just "A sub-project shares its top-level Project's area. Move that Project instead." }, Cmd.none )

                    else if Data.projectArea project == area then
                        ( dropped, Cmd.none )

                    else
                        send IgnoreReply (Command.SetProjectArea project.id (Maybe.withDefault "" area)) dropped

                Nothing ->
                    ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        SelectProject projectId ->
            selectProject projectId model

        BackToBoard ->
            send IgnoreReply
                (Command.SetProjectSelection Nothing)
                { model | selectedProjectId = Nothing, detail = Nothing, outcomeEditing = False, support = Support.init }

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

        AgentAnswerChanged key answer ->
            ( { model | agentAnswers = Dict.insert key answer model.agentAnswers }, Cmd.none )

        SendAgentAnswer runId questionId ->
            let
                key =
                    answerKey runId questionId

                answer =
                    Dict.get key model.agentAnswers |> Maybe.withDefault "" |> String.trim
            in
            if String.isEmpty answer then
                ( model, Cmd.none )

            else
                send (AnswerSent key) (Command.AnswerAgentQuestion runId questionId answer) model

        ToggleAllDiary ->
            ( { model | showAllDiary = not model.showAllDiary }, Cmd.none )

        AddDiaryEntry ->
            withSelected model
                (\projectId ->
                    if String.isEmpty (String.trim model.diaryDraft) then
                        ( model, Cmd.none )

                    else
                        send AppendDiary (Command.AddDiaryEntry projectId (String.trim model.diaryDraft)) model
                )

        SupportMsg supportMsg ->
            let
                ( support, request ) =
                    Support.update supportMsg model.support

                next =
                    { model | support = support }
            in
            case request of
                Just ask ->
                    withSelected next (\projectId -> supportRequest projectId ask next)

                Nothing ->
                    ( next, Cmd.none )

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
                    let
                        dropped =
                            { model | draggedProject = Nothing, subprojectDropTarget = Nothing }
                    in
                    if isTopLevel model projectId then
                        -- Joining a column at the end gives the Project a rank there.
                        moveProject projectId status Nothing dropped

                    else
                        showMove (Dict.singleton projectId { status = status, order = Nothing, confirmed = False })
                            (Command.SetProjectStatus projectId status)
                            dropped

                Nothing ->
                    ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        DropSubproject status beforeId ->
            case model.draggedProject of
                Just projectId ->
                    moveProject projectId status beforeId { model | draggedProject = Nothing, subprojectDropTarget = Nothing }

                Nothing ->
                    ( { model | subprojectDropTarget = Nothing }, Cmd.none )

        -- Ticked, the sub-project is completed; unticked again, it reopens as Active.
        ToggleSubprojectDone projectId done ->
            moveProject projectId
                (if done then
                    ProjectStatus.Completed

                 else
                    ProjectStatus.Active
                )
                Nothing
                model

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


{-| Moves a Project within its siblings, showing the result before the host writes it.
-}
moveProject : ProjectId -> ProjectStatus -> Maybe ProjectId -> Model -> ( Model, Cmd Msg )
moveProject projectId status beforeId model =
    showMove (placementsAfterMove model projectId status beforeId) (Command.MoveSubproject projectId status beforeId) model


{-| Shows the moves at once and sends the command that writes them. Completing or
cancelling a Project may still ask for confirmation or be refused, so that move waits
for the vault instead.
-}
showMove : Dict ProjectId PendingMove -> Command -> Model -> ( Model, Cmd Msg )
showMove moves command model =
    if Dict.isEmpty moves || List.any (\move -> List.member move.status [ ProjectStatus.Completed, ProjectStatus.Cancelled ]) (Dict.values moves) then
        send IgnoreReply command model

    else
        let
            pendingMoves =
                Dict.union moves model.pendingMoves
        in
        send (MoveProjects (Dict.keys moves))
            command
            { model | pendingMoves = pendingMoves, snapshot = withPendingMoves pendingMoves model.hostSnapshot }


{-| The placements the host will write for a move, worked out the same way as
`projectPlacementsAfterMove` in `src/domain/project-board.ts`, so the snapshot
that confirms the move can be recognised.
-}
placementsAfterMove : Model -> ProjectId -> ProjectStatus -> Maybe ProjectId -> Dict ProjectId PendingMove
placementsAfterMove model projectId status beforeId =
    case Data.findProject projectId model.snapshot.projects of
        Nothing ->
            Dict.empty

        Just moving ->
            if beforeId == Just projectId && moving.status == status then
                Dict.empty

            else
                let
                    column =
                        model.snapshot.projects
                            |> List.filter
                                (\project ->
                                    project.parentProjectId == moving.parentProjectId
                                        && project.status == status
                                        && project.id /= projectId
                                )
                            |> List.sortWith compareProjectPriority

                    ( before, after ) =
                        case beforeId |> Maybe.andThen (\id -> indexOf id column) of
                            Just index ->
                                ( List.take index column, List.drop index column )

                            Nothing ->
                                ( column, [] )

                    ordered =
                        before ++ moving :: after
                in
                ordered
                    |> List.map
                        (\project ->
                            ( project.id
                            , if project.id == projectId then
                                -- The moved Project always takes a fresh rank.
                                Nothing

                              else
                                project.order
                            )
                        )
                    |> Ranking.ranksForOrder
                    |> Dict.map (\_ order -> { status = status, order = Just order, confirmed = False })


{-| `compareProjectPriority` from the host: rank, then title, then id.
-}
compareProjectPriority : Project -> Project -> Order
compareProjectPriority left right =
    case ( left.order, right.order ) of
        ( Just leftOrder, Just rightOrder ) ->
            compare ( leftOrder, left.title, left.id ) ( rightOrder, right.title, right.id )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        ( Nothing, Nothing ) ->
            compare ( left.title, left.id ) ( right.title, right.id )


withPendingMoves : Dict ProjectId PendingMove -> Snapshot -> Snapshot
withPendingMoves moves snapshot =
    if Dict.isEmpty moves then
        snapshot

    else
        { snapshot
            | projects =
                List.map
                    (\project ->
                        case Dict.get project.id moves of
                            Just move ->
                                { project
                                    | status = move.status
                                    , order =
                                        if move.order == Nothing then
                                            project.order

                                        else
                                            move.order
                                }

                            Nothing ->
                                project
                    )
                    snapshot.projects
        }


{-| Whether the vault now holds what a pending move showed. A Project that has
gone leaves nothing to wait for.
-}
moveLanded : ProjectId -> PendingMove -> Snapshot -> Bool
moveLanded projectId move snapshot =
    case Data.findProject projectId snapshot.projects of
        Just project ->
            project.status == move.status && (move.order == Nothing || project.order == move.order)

        Nothing ->
            True


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
                , showAllDiary = False
                , tagFilters = Set.empty
                , outcomeEditing = False
                , support = Support.init
            }

        ( afterSelection, selectionCmd ) =
            send IgnoreReply (Command.SetProjectSelection (Just projectId)) next

        ( loaded, detailCmd ) =
            send IgnoreReply (Command.LoadProjectDetail projectId) afterSelection
    in
    ( loaded, Cmd.batch [ selectionCmd, detailCmd ] )


{-| What the Support tab asks of the host, for the Project shown.
-}
supportRequest : ProjectId -> Support.Request -> Model -> ( Model, Cmd Msg )
supportRequest projectId request model =
    case request of
        Support.OpenFile path ->
            send IgnoreReply (Command.OpenFile path) model

        Support.OpenUrl url ->
            send IgnoreReply (Command.OpenLink url) model

        Support.ReadNote path ->
            send (ReadSupport path) (Command.ReadSupportNote projectId path) model

        Support.SaveNote path body ->
            send IgnoreReply (Command.UpdateSupportNote projectId path body) model

        Support.CreateNoteNamed title ->
            send OpenNewSupportNote (Command.CreateSupportNote projectId title) model

        Support.CreateFolderAt path ->
            send IgnoreReply (Command.CreateSupportFolder projectId path) model

        Support.LinkFile ->
            send IgnoreReply (Command.LinkProjectFile projectId) model

        Support.UnlinkFile link ->
            send IgnoreReply (Command.UnlinkProjectFile projectId link) model

        Support.AddLinkTo url title ->
            send IgnoreReply (Command.AddProjectLink projectId url title) model

        Support.RemoveLink entry ->
            send IgnoreReply (Command.RemoveProjectLink projectId entry) model


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests }, projectsToHost (Host.envelope requestId (Command.encode command)) )


savePreferences : Model -> ( Model, Cmd Msg )
savePreferences model =
    send IgnoreReply
        (Command.SaveProjectPreferences
            { columns = model.visibleColumns, showImages = model.showImages, columnsBy = model.columnsBy, sections = model.sections }
        )
        model



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | ProjectMetaEvent (List ProjectMeta)
    | ProjectDetailEvent ProjectDetail
    | ShowProjectEvent (Maybe ProjectId)
    | ShowIssuesEvent
    | AgentEvent AgentState
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (SnapshotEvent hostSnapshot) ->
            let
                pendingMoves =
                    Dict.filter (\projectId move -> not move.confirmed && not (moveLanded projectId move hostSnapshot)) model.pendingMoves

                snapshot =
                    withPendingMoves pendingMoves hostSnapshot

                ids =
                    Set.fromList (List.map .id snapshot.projects)

                next =
                    { model
                        | snapshot = snapshot
                        , hostSnapshot = hostSnapshot
                        , pendingMoves = pendingMoves
                        , selectedIds = Set.intersect ids model.selectedIds
                    }
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

        Ok (AgentEvent agent) ->
            ( { model | agent = agent }, Cmd.none )

        Ok (ProjectDetailEvent detail) ->
            if model.selectedProjectId == Just detail.projectId then
                ( { model | detail = Just detail, outcomeDraft = detail.desiredOutcome }, Cmd.none )

            else
                ( model, Cmd.none )

        Ok ShowIssuesEvent ->
            ( { model | selectedProjectId = Nothing, detail = Nothing, issuesOnly = True }, Cmd.none )

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
            case ( outcome.result, pending ) of
                ( Err message, Just (MoveProjects projectIds) ) ->
                    -- The write failed, so the cards go back to where the vault still has them.
                    let
                        pendingMoves =
                            List.foldl Dict.remove model.pendingMoves projectIds
                    in
                    ( { model
                        | requests = requests
                        , error = Just message
                        , pendingMoves = pendingMoves
                        , snapshot = withPendingMoves pendingMoves model.hostSnapshot
                      }
                    , Cmd.none
                    )

                ( Err message, _ ) ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                ( Ok resultValue, _ ) ->
                    finish (Maybe.withDefault IgnoreReply pending) resultValue { model | requests = requests, error = Nothing }


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending resultValue model =
    case pending of
        ReadSupport path ->
            case Decode.decodeValue Decode.string resultValue of
                Ok body ->
                    ( { model | support = Support.gotNoteBody path body model.support }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        AnswerSent key ->
            ( { model | agentAnswers = Dict.remove key model.agentAnswers }, Cmd.none )

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
                    let
                        ( support, request ) =
                            Support.noteCreated path model.support
                    in
                    withSelected { model | support = support } (\projectId -> supportRequest projectId request { model | support = support })

                Err _ ->
                    ( model, Cmd.none )

        MoveProjects projectIds ->
            -- Written. The snapshot that follows is the truth, even if it differs from what was shown.
            ( { model
                | pendingMoves =
                    List.foldl (\projectId moves -> Dict.update projectId (Maybe.map (\move -> { move | confirmed = True })) moves)
                        model.pendingMoves
                        projectIds
              }
            , Cmd.none
            )

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
                , button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewProjectModal Nothing ProjectStatus.Active)) ] [ text "New Project" ]
                ]
            ]
        , Ui.issuesView (\path -> Send IgnoreReply (Command.OpenFile path)) model.snapshot.issues
        , div [ class "dg-toolbar dg-project-toolbar" ]
            [ input [ type_ "search", placeholder "Search Projects", value model.search, onInput SearchChanged ] []
            , label [ class "dg-toolbar-toggle" ]
                [ input [ type_ "checkbox", checked model.issuesOnly, onCheck ToggleIssues ] [], span [] [ text "Issues only" ] ]
            , Ui.labelled "Columns"
                (select [ tabindex 0, onInput (\raw -> SetColumnsBy (if raw == "area" then ColumnsByArea else ColumnsByStatus)) ]
                    [ option [ value "status", selected (model.columnsBy == ColumnsByStatus) ] [ text "Columns: Status" ]
                    , option [ value "area", selected (model.columnsBy == ColumnsByArea) ] [ text "Columns: Area" ]
                    ]
                )
            , Ui.labelled "Sections"
                (select
                    [ tabindex 0
                    , onInput
                        (\raw ->
                            SetSections
                                (case raw of
                                    "area" ->
                                        SectionsByArea

                                    "status" ->
                                        SectionsByStatus

                                    _ ->
                                        NoSections
                                )
                        )
                    ]
                    (option [ value "none", selected (model.sections == NoSections) ] [ text "Sections: None" ]
                        :: (case model.columnsBy of
                                ColumnsByStatus ->
                                    [ option [ value "area", selected (model.sections == SectionsByArea) ] [ text "Sections: Area" ] ]

                                ColumnsByArea ->
                                    [ option [ value "status", selected (model.sections == SectionsByStatus) ] [ text "Sections: Status" ] ]
                           )
                    )
                )
            , -- With area columns the statuses become a filter, so the picker says so.
              button [ classList [ ( "is-active", model.columnsOpen ) ], onClick ToggleColumns ]
                [ text
                    (case model.columnsBy of
                        ColumnsByStatus ->
                            "Show columns"

                        ColumnsByArea ->
                            "Show statuses"
                    )
                ]
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
            (case model.columnsBy of
                ColumnsByStatus ->
                    ProjectStatus.board
                        |> List.filter (\status -> List.member status model.visibleColumns)
                        |> List.map
                            (\status ->
                                if isSecondaryColumn status && not (List.member status model.expandedColumns) then
                                    viewCollapsedColumn model status

                                else
                                    viewProjectColumn model status
                            )

                ColumnsByArea ->
                    viewAreaColumns model
            )
        ]


{-| One column per area, holding the Projects of the statuses shown. Dropping a
top-level Project on another column moves it to that area; sub-projects share
their top-level Project's area and stay put.
-}
viewAreaColumns : Model -> List (Html Msg)
viewAreaColumns model =
    let
        projects =
            visibleProjects model
                |> List.filter (\project -> List.member project.status model.visibleColumns)
                |> List.sortWith (\left right -> compare (statusRank left.status) (statusRank right.status) |> thenCompare (Hierarchy.compareByOrder left right))

        columns =
            byArea model.snapshot.projects projects
    in
    if List.isEmpty columns then
        [ div [ class "dg-empty" ] [ text "No Projects in the statuses shown." ] ]

    else
        List.map (viewAreaColumn model) columns


viewAreaColumn : Model -> ( Maybe String, List Project ) -> Html Msg
viewAreaColumn model ( area, projects ) =
    let
        issues =
            projects |> List.filter (\project -> (projectMeta project.id model).actionIssue /= Nothing) |> List.length
    in
    section
        [ class "dg-column dg-project-column"
        , attribute "data-column" (Maybe.withDefault "" area)
        , dragOver
        , on "drop" (Decode.succeed (DropOnArea area))
        ]
        [ header [ class "dg-column-header" ]
            [ span [] [ text (Maybe.withDefault "No area" area) ]
            , span [ class "dg-project-column-counts" ]
                (text (Ui.plural (List.length projects) "Project")
                    :: (if issues > 0 then
                            [ span [ class "dg-project-column-health" ] [ text (Ui.plural issues "issue") ] ]

                        else
                            []
                       )
                )
            ]
        , div [ class "dg-card-list" ]
            (case model.sections of
                SectionsByStatus ->
                    ProjectStatus.board
                        |> List.filterMap
                            (\status ->
                                case List.filter (\project -> project.status == status) projects of
                                    [] ->
                                        Nothing

                                    inStatus ->
                                        Just (viewCardSection model (ProjectStatus.label status) inStatus)
                            )

                _ ->
                    List.map (viewProjectCard model) projects
            )
        ]


statusRank : ProjectStatus -> Int
statusRank status =
    ProjectStatus.board
        |> List.indexedMap Tuple.pair
        |> List.filter (\( _, candidate ) -> candidate == status)
        |> List.head
        |> Maybe.map Tuple.first
        |> Maybe.withDefault 99


thenCompare : Order -> Order -> Order
thenCompare next first =
    if first == EQ then
        next

    else
        first


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
    List.member status [ ProjectStatus.Someday, ProjectStatus.Completed, ProjectStatus.Cancelled ]


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

             else if model.sections == SectionsByArea then
                List.map (\( area, inArea ) -> viewCardSection model (Maybe.withDefault "No area" area) inArea)
                    (byArea model.snapshot.projects projects)

             else
                List.map (viewProjectCard model) projects
            )
        ]


{-| Projects split by area, keeping each column's rank inside an area. Areas sort
alphabetically, ignoring case, with Projects that have none last. A sub-project
sits under its top-level Project's area.
-}
byArea : List Project -> List Project -> List ( Maybe String, List Project )
byArea allProjects projects =
    let
        areaOf =
            Hierarchy.area allProjects

        inArea area =
            List.filter (\project -> areaOf project == area) projects

        withoutArea =
            inArea Nothing

        areas =
            projects |> List.filterMap areaOf |> Ui.uniqueSorted |> List.sortBy String.toLower
    in
    List.map (\area -> ( Just area, inArea (Just area) )) areas
        ++ (if List.isEmpty withoutArea then
                []

            else
                [ ( Nothing, withoutArea ) ]
           )


{-| One section of a column: a heading with its count, then its cards in order.
-}
viewCardSection : Model -> String -> List Project -> Html Msg
viewCardSection model heading projects =
    section [ class "dg-board-section" ]
        (h3 [ class "dg-board-section-heading" ]
            [ span [] [ text heading ]
            , span [ class "dg-board-section-count" ] [ text (String.fromInt (List.length projects)) ]
            ]
            :: List.map (viewProjectCard model) projects
        )


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
            ++ (case model.columnsBy of
                    ColumnsByStatus ->
                        rankDropAttributes model project

                    -- In area columns a drop changes the area, not the order.
                    ColumnsByArea ->
                        []
               )
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
        , -- The area already heads the column or section the card sits in.
          if model.columnsBy == ColumnsByArea || model.sections == SectionsByArea then
            text ""

          else
            Ui.maybeView (Hierarchy.area model.snapshot.projects project) (\area -> div [ class "dg-project-area" ] [ text area ])
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
                [ Ui.maybeView parent (\item -> button [ class "dg-parent-back", onClick (SelectProject item.id) ] [ span [ class "dg-parent-back-label" ] [ text ("← " ++ item.title) ] ])
                , button [ onClick BackToBoard ] [ text "← Projects" ]
                , h2 [] [ text project.title ]
                , span [ class ("dg-status dg-status-" ++ ProjectStatus.key project.status) ] [ text (ProjectStatus.label project.status) ]
                , if onlyWaiting model project then
                    waitingOnlyBadge

                  else
                    text ""
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
                    , viewSubprojects model project
                    , viewAgent model project
                    ]

                SupportTab ->
                    viewDiary model
                        :: (case model.detail of
                                Just detail ->
                                    List.map (Html.map SupportMsg) (Support.view project.supportPath detail.material model.support)

                                Nothing ->
                                    []
                           )
            )
        ]


{-| The Project's agent runs: status, cost, the agent's questions with a place to
answer them, and the way to its report. Also what delegating has cost this tree.
-}
viewAgent : Model -> Project -> Html Msg
viewAgent model project =
    let
        runs =
            List.filter (\run -> run.projectId == project.id) model.agent.runs

        cost =
            Dict.get project.id model.agent.costs
    in
    if not model.agent.available && List.isEmpty runs then
        text ""

    else
        section [ class "dg-detail-section dg-agent-panel" ]
            [ div [ class "dg-detail-section-heading" ]
                [ h3 [ class "dg-detail-eyebrow" ] [ text "Agent" ]
                , div [ class "dg-detail-section-actions" ]
                    [ Ui.maybeView cost (\amounts -> span [ class "dg-agent-cost" ] [ text (costSummary amounts) ])
                    , if model.agent.available then
                        button [ onClick (Send IgnoreReply (Command.DelegateProject project.id)) ] [ text "Delegate to agent…" ]

                      else
                        text ""
                    ]
                ]
            , if List.isEmpty runs then
                p [ class "dg-muted" ] [ text "No runs yet. An agent works on a copy of this Project's tree and adds its results to the Project Material." ]

              else
                div [ class "dg-agent-runs" ] (List.map (viewAgentRun model) runs)
            ]


viewAgentRun : Model -> AgentRun -> Html Msg
viewAgentRun model run =
    let
        active =
            List.member run.status [ "queued", "starting", "running", "waiting" ]

        -- A local run costs nothing, and a Codex run is paid by the ChatGPT plan; what matters there is
        -- which model it used and what it could reach.
        spent =
            if run.runtime == "lamdera" then
                "Code: "
                    ++ run.repository
                    ++ (if String.isEmpty run.branch then
                            ""

                        else
                            " · " ++ run.branch
                       )

            else if run.runtime == "codex" then
                "ChatGPT plan (Codex): " ++ run.model

            else if run.runtime == "local" then
                String.join " · "
                    ((case run.harness of
                        "smolagents" ->
                            "Local (smolagents): " ++ run.model

                        "qwen-agent" ->
                            "Local (Qwen-Agent): " ++ run.model

                        _ ->
                            "Local: " ++ run.model
                     )
                        :: (if run.wholeVault then
                                [ "whole vault" ]

                            else
                                []
                           )
                        ++ (if run.offline then
                                [ "offline" ]

                            else
                                []
                           )
                    )

            else
                case run.costUsd of
                    Just amount ->
                        usd amount ++ " of " ++ usd run.budgetUsd

                    Nothing ->
                        "Budget " ++ usd run.budgetUsd
    in
    article [ classList [ ( "dg-agent-run", True ), ( "is-waiting", run.status == "waiting" ) ] ]
        [ div [ class "dg-agent-run-heading" ]
            [ div []
                [ strong [] [ text run.statusText ]
                , span [ class "dg-agent-run-meta" ] [ text (run.createdAt ++ " · " ++ spent) ]
                ]
            , div [ class "dg-detail-section-actions" ]
                [ if String.isEmpty run.reportPath then
                    text ""

                  else
                    button [ onClick (Send IgnoreReply (Command.OpenFile run.reportPath)) ] [ text "Open report" ]
                , linkButton "Pull request" run.pullRequestUrl
                , linkButton "Preview" run.previewUrl
                , if active then
                    button [ class "mod-warning", onClick (Send IgnoreReply (Command.StopAgentRun run.id)) ]
                        [ text
                            (if run.status == "queued" then
                                "Remove from queue"

                             else
                                "Stop"
                            )
                        ]

                  else
                    text ""
                , -- Opens the Delegate dialog filled in from this run, to adjust and start again. A code run
                  -- can also follow up on a finished one: it continues on the same branch and pull request.
                  if model.agent.available && run.runtime == "lamdera" && run.status == "finished" then
                    button [ onClick (Send IgnoreReply (Command.RerunAgentRun run.id)) ] [ text "Follow up…" ]

                  else if model.agent.available && List.member run.status [ "failed", "stopped", "interrupted" ] then
                    button [ onClick (Send IgnoreReply (Command.RerunAgentRun run.id)) ] [ text "Run again…" ]

                  else
                    text ""
                , -- Ended runs only; the host asks first, since the run folder has no trash.
                  if model.agent.available && not active then
                    button [ class "mod-warning", onClick (Send IgnoreReply (Command.DeleteAgentRun run.id)) ] [ text "Delete…" ]

                  else
                    text ""
                ]
            ]
        , div [] (List.map (viewAgentQuestion model run) run.questions)
        , viewAgentActivity run
        ]


{-| A button that opens a link a run published, when it published one.
-}
linkButton : String -> String -> Html Msg
linkButton label url =
    if String.isEmpty url then
        text ""

    else
        button [ onClick (Send IgnoreReply (Command.OpenLink url)) ] [ text label ]


{-| What the agent is doing, folded away: the collapsed line shows its latest step, so
progress is visible without opening it. The box keeps its open state across updates,
since it is left to the browser.
-}
viewAgentActivity : AgentRun -> Html Msg
viewAgentActivity run =
    case run.activity of
        [] ->
            text ""

        latest :: _ ->
            node "details"
                [ class "dg-agent-activity" ]
                [ node "summary"
                    []
                    [ span [ class "dg-agent-activity-label" ] [ text "What it's doing" ]
                    , span [ class "dg-agent-activity-latest" ] [ text (activityLabel latest.kind ++ " " ++ latest.text) ]
                    ]
                , Html.ul [ class "dg-agent-activity-list" ]
                    (List.map
                        (\entry ->
                            Html.li [ classList [ ( "dg-agent-activity-entry", True ), ( "is-" ++ entry.kind, True ) ] ]
                                [ span [ class "dg-agent-activity-time" ] [ text entry.at ]
                                , span [] [ text (activityLabel entry.kind ++ " " ++ entry.text) ]
                                ]
                        )
                        run.activity
                    )
                ]


{-| A symbol and a word, so the kind of step is not told by colour or symbol alone.
-}
activityLabel : String -> String
activityLabel kind =
    case kind of
        "thought" ->
            "💭 Thinking:"

        "tool" ->
            "🔧"

        _ ->
            "🤖"


viewAgentQuestion : Model -> AgentRun -> AgentQuestion -> Html Msg
viewAgentQuestion model run question =
    let
        key =
            answerKey run.id question.id

        draft =
            Dict.get key model.agentAnswers |> Maybe.withDefault ""
    in
    div [ class "dg-agent-question" ]
        [ p [ class "dg-agent-question-text" ] [ text ("❓ " ++ question.question) ]
        , Ui.labelled "Your answer"
            (textarea
                [ rows 3
                , value draft
                , placeholder "Your answer…"
                , onInput (AgentAnswerChanged key)
                , Ui.onModEnter (SendAgentAnswer run.id question.id)
                ]
                []
            )
        , div [ class "dg-agent-question-actions" ]
            [ button
                [ class "mod-cta"
                , disabled (String.isEmpty (String.trim draft))
                , onClick (SendAgentAnswer run.id question.id)
                ]
                [ text "Answer" ]
            ]
        ]


answerKey : String -> String -> String
answerKey runId questionId =
    runId ++ "/" ++ questionId


costSummary : { own : Float, tree : Float } -> String
costSummary amounts =
    if amounts.tree > amounts.own then
        "Agent cost: " ++ usd amounts.own ++ " here, " ++ usd amounts.tree ++ " with sub-projects"

    else
        "Agent cost: " ++ usd amounts.own


usd : Float -> String
usd amount =
    let
        cents =
            round (amount * 100)
    in
    "$" ++ String.fromInt (cents // 100) ++ "." ++ String.padLeft 2 '0' (String.fromInt (modBy 100 cents))


viewDetailTabs : Model -> Project -> List Action -> Html Msg
viewDetailTabs model project openActions =
    let
        supportCount =
            Maybe.map
                (\detail ->
                    List.length detail.diary + Support.count detail.material
                )
                model.detail

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
        , tab SupportTab "Support material" supportCount
        ]




viewOutcome : Model -> Project -> Html Msg
viewOutcome model project =
    let
        outcome =
            Maybe.map .desiredOutcome model.detail |> Maybe.withDefault ""
    in
    section [ class "dg-detail-section dg-project-outcome-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ h3 [ class "dg-detail-eyebrow" ] [ text "Desired outcome" ]
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
                    , Ui.onModEnter SaveOutcome
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
                [ h3 [ class "dg-detail-eyebrow" ] [ text "Open Actions" ]
                , div [ class "dg-detail-section-actions" ]
                    [ span [ class "dg-detail-count" ] [ text (String.fromInt (List.length openActions)) ]
                    , button [ onClick (Send IgnoreReply (Command.ImportActionsModal project.id)) ] [ text "Import…" ]
                    , button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewActionModal (Just project.id))) ] [ text "New Action" ]
                    ]
                ]
            , viewActionRows model.snapshot.today openActions
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
                    viewActionRows model.snapshot.today completedActions

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


viewActionRows : String -> List Action -> Html Msg
viewActionRows today actions =
    if List.isEmpty actions then
        div [ class "dg-detail-empty" ] [ text "No Actions." ]

    else
        div [ class "dg-action-rows" ] (List.map (viewActionRow today) actions)


{-| An Action's title with the links written in it clickable.
-}
titleLinks : Action -> List (Html Msg)
titleLinks action =
    Links.view
        { openUrl = \url -> Send IgnoreReply (Command.OpenLink url)
        , openNote = \link -> Send IgnoreReply (Command.OpenNoteLink link action.file.path)
        }
        action.title


viewActionRow : String -> Action -> Html Msg
viewActionRow today action =
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
            [ span [ class "dg-action-row-title" ] (titleLinks action)
            , div [ class "dg-action-row-meta" ]
                ((if action.status == ActionStatus.Next then
                    []

                  else
                    [ span [ class ("dg-action-status dg-action-status-" ++ ActionStatus.key action.status) ]
                        [ text (ActionStatus.label action.status) ]
                    ]
                 )
                    ++ Ui.maybeList (Data.scheduleText today action) (\schedule -> span [ class "dg-action-schedule" ] [ text ("🗓 " ++ schedule) ])
                    ++ Ui.maybeList action.context (\context -> span [] [ text ("@" ++ context) ])
                    ++ Ui.maybeList action.energy Energy.badge
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
            List.filter (\child -> List.member child.status secondaryStatuses) visible
    in
    section [ class "dg-detail-section dg-subprojects-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ h3 [ class "dg-detail-eyebrow" ] [ text "Sub-projects" ]
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
            (List.map (viewSubprojectColumn model project primary) [ ProjectStatus.Active, ProjectStatus.Backlog ])
        , div [ classList [ ( "dg-subproject-secondary", True ), ( "is-open", model.showSecondary ) ] ]
            [ button [ class "dg-disclosure dg-subproject-secondary-toggle dg-flat-button", onClick ToggleSecondary ]
                [ span [] [ text (disclosure model.showSecondary ++ " Someday/Maybe, Completed and Cancelled") ]
                , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length secondary)) ]
                ]
            , if model.showSecondary then
                div [ class "dg-subproject-columns dg-subproject-columns-secondary" ]
                    (List.map (viewSubprojectColumn model project secondary) secondaryStatuses)

              else
                text ""
            ]
        ]


secondaryStatuses : List ProjectStatus
secondaryStatuses =
    [ ProjectStatus.Someday, ProjectStatus.Completed, ProjectStatus.Cancelled ]


viewSubprojectColumn : Model -> Project -> List Project -> ProjectStatus -> Html Msg
viewSubprojectColumn model parent projects status =
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
        , if List.member status [ ProjectStatus.Active, ProjectStatus.Backlog ] then
            -- Each column creates sub-projects in its own status, so no move is needed afterwards.
            button
                [ class "dg-subproject-add"
                , onClick (Send IgnoreReply (Command.NewProjectModal (Just parent.id) status))
                ]
                (Ui.iconLabel "+ New sub-project" ("New " ++ ProjectStatus.label status ++ " sub-project"))

          else
            text ""
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
        meta =
            projectMeta project.id model

        blockers =
            meta.blockers
    in
    article
        [ classList
            [ ( "dg-subproject-card", True )
            , ( "is-blocked", not (List.isEmpty blockers) )
            , ( "has-issue", meta.actionIssue /= Nothing )
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
            [ Ui.labelled
                ((if project.status == ProjectStatus.Completed then
                    "Reopen "

                  else
                    "Mark completed: "
                 )
                    ++ project.title
                )
                (input
                    [ type_ "checkbox"
                    , class "dg-subproject-done"
                    , checked (project.status == ProjectStatus.Completed)
                    , onCheck (ToggleSubprojectDone project.id)
                    ]
                    []
                )
            , button [ class "dg-subproject-title dg-flat-button", onClick (SelectProject project.id) ] [ text project.title ]
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
        , Ui.maybeView meta.actionIssue (\issue -> div [ class "dg-project-health" ] [ text issue ])
        , if onlyWaiting model project then
            div [] [ waitingOnlyBadge ]

          else
            text ""
        ]


viewDiary : Model -> Html Msg
viewDiary model =
    let
        entries =
            Maybe.map .diary model.detail |> Maybe.withDefault []
    in
    section [ class "dg-detail-section dg-project-diary-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ h3 [ class "dg-detail-eyebrow" ] [ text "Diary" ]
            , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length entries)) ]
            ]
        , div [ class "dg-diary-add" ]
            [ textarea
                [ value model.diaryDraft
                , rows 3
                , placeholder ("Observation or decision… (" ++ saveChord model ++ " to add)")
                , onInput DiaryChanged
                , Ui.onModEnter AddDiaryEntry
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
                List.map (\entry -> div [] [ span [] [ text entry.timestamp ], p [] [ text entry.body ] ])
                    (if model.showAllDiary then
                        entries

                     else
                        List.take diaryPreview entries
                    )
            )
        , if List.length entries > diaryPreview then
            button [ class "dg-disclosure dg-diary-more dg-flat-button", onClick ToggleAllDiary ]
                [ text
                    (if model.showAllDiary then
                        "Show latest " ++ String.fromInt diaryPreview

                     else
                        "Show all " ++ String.fromInt (List.length entries) ++ " entries"
                    )
                ]

          else
            text ""
        ]


{-| Entries the diary shows before it is expanded, so a long one does not push
the files far down.
-}
diaryPreview : Int
diaryPreview =
    5


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
            ++ areaEntries model project
            ++ [ MenuSeparator
               , MenuItem "Start Pomodoro…" (Command.OpenPomodoro project.id)
               ]
            ++ delegateEntry model project
            ++ [ MenuItem "New Action…" (Command.NewActionModal (Just project.id))
               , MenuItem "New sub-project…" (Command.NewProjectModal (Just project.id) ProjectStatus.Active)
               , MenuItem "Open note" (Command.OpenFile project.file.path)
               , MenuItem "Edit…" (Command.EditProjectModal project.id)
               , MenuSeparator
               , MenuItem "Delete Project…" (Command.TrashProject project.id)
               ]
        )


{-| Moves a Project into any area another Project already uses; new areas are
typed in the edit modal.
-}
areaEntries : Model -> Project -> List MenuEntry
areaEntries model project =
    let
        current =
            Data.projectArea project

        entry label area =
            MenuItem
                ((if current == area then
                    "✓ "

                  else
                    ""
                 )
                    ++ label
                )
                (Command.SetProjectArea project.id (Maybe.withDefault "" area))
    in
    case ( project.parentProjectId, Data.areas model.snapshot.projects ) of
        -- Sub-projects share their top-level Project's area.
        ( Just _, _ ) ->
            []

        ( Nothing, [] ) ->
            []

        ( Nothing, areas ) ->
            MenuSeparator
                :: List.map (\area -> entry ("Area: " ++ area) (Just area)) areas
                ++ [ entry "No area" Nothing ]


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
               ]
            ++ delegateEntry model project
            ++ [ MenuItem "New Action…" (Command.NewActionModal (Just project.id))
               , MenuItem "New sub-project…" (Command.NewProjectModal (Just project.id) ProjectStatus.Active)
               , MenuSeparator
               , MenuItem "Delete Project…" (Command.TrashProject project.id)
               ]
        )


delegateEntry : Model -> Project -> List MenuEntry
delegateEntry model project =
    if model.agent.available then
        [ MenuItem "Delegate to agent…" (Command.DelegateProject project.id) ]

    else
        []


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
            Ui.matches model.search [ project.title, meta.breadcrumb, Maybe.withDefault "" (Hierarchy.area model.snapshot.projects project) ]
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


{-| Whether every open Action in the Project's tree is Waiting: it is moving, but
nothing in it is yours to do until someone answers. Finished Projects don't count.
-}
onlyWaiting : Model -> Project -> Bool
onlyWaiting model project =
    let
        tree =
            Set.insert project.id (Hierarchy.descendantIds project.id model.snapshot.projects)

        open =
            model.snapshot.actions
                |> List.filter
                    (\action ->
                        ActionStatus.isOpen action.status
                            && (Maybe.map (\projectId -> Set.member projectId tree) action.projectId |> Maybe.withDefault False)
                    )
    in
    ProjectStatus.isOpen project.status
        && not (List.isEmpty open)
        && List.all (\action -> action.status == ActionStatus.Waiting) open


waitingOnlyBadge : Html msg
waitingOnlyBadge =
    span [ class "dg-waiting-only" ] [ text "⏳ Only Waiting Actions" ]


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


agentDecoder : Decoder AgentState
agentDecoder =
    Decode.map3 AgentState
        (Decode.field "available" Decode.bool)
        (Decode.field "runs" (Decode.list agentRunDecoder))
        (Decode.field "costs"
            (Decode.list
                (Decode.map3 (\projectId own tree -> ( projectId, { own = own, tree = tree } ))
                    (Decode.field "projectId" Decode.string)
                    (Decode.field "own" Decode.float)
                    (Decode.field "tree" Decode.float)
                )
                |> Decode.map Dict.fromList
            )
        )


agentRunDecoder : Decoder AgentRun
agentRunDecoder =
    Decode.succeed AgentRun
        |> andMap (Decode.field "id" Decode.string)
        |> andMap (Decode.field "projectId" Decode.string)
        |> andMap (Decode.field "createdAt" Decode.string)
        |> andMap (Decode.field "status" Decode.string)
        |> andMap (Decode.field "statusText" Decode.string)
        |> andMap (Decode.field "costUsd" (Decode.nullable Decode.float))
        |> andMap (Decode.field "budgetUsd" Decode.float)
        |> andMap (Decode.field "runtime" Decode.string)
        |> andMap (Decode.field "harness" Decode.string)
        |> andMap (Decode.field "model" Decode.string)
        |> andMap (Decode.field "offline" Decode.bool)
        |> andMap (Decode.field "wholeVault" Decode.bool)
        |> andMap (Decode.field "reportPath" Decode.string)
        |> andMap
            (Decode.field "questions"
                (Decode.list
                    (Decode.map3 AgentQuestion
                        (Decode.field "id" Decode.string)
                        (Decode.field "question" Decode.string)
                        (Decode.field "askedAt" Decode.string)
                    )
                )
            )
        |> andMap
            (Decode.field "activity"
                (Decode.list
                    (Decode.map3 AgentActivity
                        (Decode.field "at" Decode.string)
                        (Decode.field "kind" Decode.string)
                        (Decode.field "text" Decode.string)
                    )
                )
            )
        |> andMap (Decode.field "repository" Decode.string)
        |> andMap (Decode.field "branch" Decode.string)
        |> andMap (Decode.field "pullRequestUrl" Decode.string)
        |> andMap (Decode.field "previewUrl" Decode.string)


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    Decode.map2 (|>)


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


projectDetailDecoder : Decoder ProjectDetail
projectDetailDecoder =
    Decode.map4 ProjectDetail
        (Decode.field "projectId" Decode.string)
        (Decode.field "desiredOutcome" Decode.string)
        (Decode.field "diary" (Decode.list diaryDecoder))
        Support.materialDecoder


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

                    "show-issues" ->
                        Decode.succeed ShowIssuesEvent

                    "agent" ->
                        Decode.map AgentEvent (Decode.field "agent" agentDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


emptyModel : String -> Model
emptyModel message =
    { snapshot = Data.empty
    , hostSnapshot = Data.empty
    , pendingMoves = Dict.empty
    , meta = Dict.empty
    , selectedProjectId = Nothing
    , detail = Nothing
    , search = ""
    , issuesOnly = False
    , showSubprojects = False
    , showImages = False
    , columnsBy = ColumnsByStatus
    , sections = NoSections
    , visibleColumns = ProjectStatus.defaultColumns
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
    , showAllDiary = False
    , support = Support.init
    , draggedProject = Nothing
    , subprojectDropTarget = Nothing
    , agent = emptyAgent
    , agentAnswers = Dict.empty
    , requests = Host.noRequests
    , error = Just message
    , isMac = False
    }
