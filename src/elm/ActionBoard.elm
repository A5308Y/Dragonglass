port module ActionBoard exposing (main)

import Browser
import Browser.Dom
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Command.ActionBoard as Command exposing (Command, MenuEntry(..))
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Settings as Settings
    exposing
        ( BoardConfiguration
        , DueRange(..)
        , Filter(..)
        , GroupBy(..)
        , MatchOperator(..)
        , SortDirection(..)
        , SortField(..)
        , VisibleColumns(..)
        )
import Gtd.Ui as Ui exposing (Key(..))
import Html exposing (Html, article, button, div, h2, header, input, label, option, section, select, span, text)
import Html.Attributes exposing (attribute, checked, class, classList, disabled, draggable, id, placeholder, selected, tabindex, title, type_, value)
import Html.Events exposing (custom, on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Task


port toHost : Encode.Value -> Cmd msg


port fromHost : (Decode.Value -> msg) -> Sub msg


{-| Which bucket an Action falls into under the current grouping.
-}
type GroupKey
    = StatusGroup ActionStatus
    | ProjectGroup (Maybe ProjectId)
    | ContextGroup (Maybe String)
    | EnergyGroup (Maybe String)


type alias Group =
    { key : GroupKey, actions : List Action }


{-| The field a new filter asks about, as chosen in the builder.
-}
type FilterField
    = FieldStatus
    | FieldProject
    | FieldContext
    | FieldEnergy
    | FieldDue
    | FieldAvailable
    | FieldWork


{-| The comparison a due-date filter draft is set to, before it is given an operand.
-}
type DueOperator
    = OpBefore
    | OpOnOrBefore
    | OpAfter
    | OpOnOrAfter
    | OpWithinNextDays
    | OpIsEmpty
    | OpIsNotEmpty


type alias FilterDraft =
    { field : FilterField
    , operator : MatchOperator
    , value : String
    , dueOperator : DueOperator
    , dueValue : String
    }


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | CreateSavedView
    | MoveAction ActionId ActionStatus


type alias Model =
    { snapshot : Snapshot
    , activeViewId : Maybe String
    , configuration : BoardConfiguration
    , search : String
    , allProjects : Bool
    , filterOpen : Bool
    , columnsOpen : Bool
    , draft : FilterDraft
    , dragged : Maybe ActionId
    , priorityDropTarget : Maybe ActionId
    , optimistic : Dict ActionId ActionStatus
    , savedViewSeed : Int
    , requests : Requests Pending
    , fatalError : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleAllProjects Bool
    | ToggleFilters
    | ToggleColumns
    | SelectSavedView String
    | SetGroupBy GroupBy
    | SetSortField SortField
    | ReverseSort
    | SaveView
    | SaveViewAs
    | DeleteView
    | SetFilterField FilterField
    | SetFilterOperator MatchOperator
    | SetFilterValue String
    | SetDueOperator DueOperator
    | SetDueValue String
    | AddFilter
    | RemoveFilter Int
    | ToggleColumn GroupKey
    | DragStarted ActionId
    | DragOver
    | DragOverCard ActionId
    | DragEnded
    | DropOn ActionStatus
    | DropBefore ActionId
    | CardKey ActionId Key
    | Focused (Result Browser.Dom.Error ())
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> fromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue Data.snapshotDecoder flags of
        Ok snapshot ->
            let
                active =
                    snapshot.settings.activeSavedViewId

                configuration =
                    active
                        |> Maybe.andThen (Settings.findSavedView snapshot.settings.savedViews)
                        |> Maybe.map .configuration
                        |> Maybe.withDefault (Settings.defaultConfiguration snapshot.settings)
            in
            ( initialModel snapshot active configuration, Cmd.none )

        Err error ->
            let
                fallback =
                    initialModel Data.empty Nothing (Settings.defaultConfiguration Settings.empty)
            in
            ( { fallback | fatalError = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Snapshot -> Maybe String -> BoardConfiguration -> Model
initialModel snapshot active configuration =
    { snapshot = snapshot
    , activeViewId = active
    , configuration = configuration
    , search = ""
    , allProjects = False
    , filterOpen = False
    , columnsOpen = False
    , draft = initialDraft snapshot.today
    , dragged = Nothing
    , priorityDropTarget = Nothing
    , optimistic = Dict.empty
    , savedViewSeed = 1
    , requests = Host.noRequests
    , fatalError = Nothing
    }


initialDraft : String -> FilterDraft
initialDraft today =
    { field = FieldStatus
    , operator = Is
    , value = ActionStatus.key ActionStatus.Next
    , dueOperator = OpOnOrBefore
    , dueValue = today
    }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        SearchChanged query ->
            ( { model | search = query }, Cmd.none )

        ToggleAllProjects shown ->
            ( { model | allProjects = shown }, Cmd.none )

        ToggleFilters ->
            ( { model | filterOpen = not model.filterOpen }, Cmd.none )

        ToggleColumns ->
            ( { model | columnsOpen = not model.columnsOpen }, Cmd.none )

        SelectSavedView savedId ->
            let
                selectedView =
                    Settings.findSavedView model.snapshot.settings.savedViews savedId

                nextId =
                    Maybe.map .id selectedView

                configuration =
                    Maybe.map .configuration selectedView
                        |> Maybe.withDefault (Settings.defaultConfiguration model.snapshot.settings)

                settings =
                    model.snapshot.settings
            in
            send IgnoreReply
                (Command.SetActiveSavedView nextId)
                { model | activeViewId = nextId, configuration = configuration }

        SetGroupBy groupBy ->
            ( { model | configuration = withConfiguration model (\config -> { config | groupBy = groupBy, visibleColumns = AllColumns }) }, Cmd.none )

        SetSortField field ->
            ( { model
                | configuration =
                    withConfiguration model (\config -> { config | sort = { field = field, direction = config.sort.direction } })
              }
            , Cmd.none
            )

        ReverseSort ->
            ( { model
                | configuration =
                    withConfiguration model
                        (\config -> { config | sort = { field = config.sort.field, direction = Settings.reverse config.sort.direction } })
              }
            , Cmd.none
            )

        SaveView ->
            case model.activeViewId of
                Just _ ->
                    saveCurrentView model

                Nothing ->
                    promptForView False model

        SaveViewAs ->
            promptForView True model

        DeleteView ->
            deleteCurrentView model

        SetFilterField field ->
            let
                draft =
                    model.draft
            in
            ( { model
                | draft =
                    { draft
                        | field = field
                        , value =
                            if field == FieldStatus then
                                ActionStatus.key ActionStatus.Next

                            else
                                ""
                    }
              }
            , Cmd.none
            )

        SetFilterOperator operator ->
            ( { model | draft = withDraft model (\draft -> { draft | operator = operator }) }, Cmd.none )

        SetFilterValue next ->
            ( { model | draft = withDraft model (\draft -> { draft | value = next }) }, Cmd.none )

        SetDueOperator operator ->
            ( { model
                | draft =
                    withDraft model
                        (\draft ->
                            { draft
                                | dueOperator = operator
                                , dueValue =
                                    if operator == OpWithinNextDays then
                                        "7"

                                    else
                                        model.snapshot.today
                            }
                        )
              }
            , Cmd.none
            )

        SetDueValue next ->
            ( { model | draft = withDraft model (\draft -> { draft | dueValue = next }) }, Cmd.none )

        AddFilter ->
            case draftFilter model of
                Just filter ->
                    ( { model | configuration = withConfiguration model (\config -> { config | filters = config.filters ++ [ filter ] }) }, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        RemoveFilter index ->
            ( { model | configuration = withConfiguration model (\config -> { config | filters = removeAt index config.filters }) }, Cmd.none )

        ToggleColumn key ->
            let
                shown =
                    columnCandidates model |> List.map groupKeyString

                visible =
                    case model.configuration.visibleColumns of
                        AllColumns ->
                            shown

                        OnlyColumns columns ->
                            columns

                wanted =
                    groupKeyString key

                next =
                    if List.member wanted visible then
                        List.filter ((/=) wanted) visible

                    else
                        List.filter (\candidate -> candidate == wanted || List.member candidate visible) shown
            in
            ( { model | configuration = withConfiguration model (\config -> { config | visibleColumns = OnlyColumns next }) }, Cmd.none )

        DragStarted actionId ->
            ( { model | dragged = Just actionId, priorityDropTarget = Nothing }, Cmd.none )

        DragOver ->
            ( { model | priorityDropTarget = Nothing }, Cmd.none )

        DragOverCard actionId ->
            ( { model | priorityDropTarget = Just actionId }, Cmd.none )

        DragEnded ->
            ( { model | dragged = Nothing, priorityDropTarget = Nothing }, Cmd.none )

        DropOn status ->
            case model.dragged of
                Just actionId ->
                    moveAction actionId status { model | dragged = Nothing, priorityDropTarget = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        DropBefore targetId ->
            case model.dragged of
                Just actionId ->
                    if actionId == targetId then
                        ( { model | dragged = Nothing, priorityDropTarget = Nothing }, Cmd.none )

                    else
                        send IgnoreReply
                            (Command.SetActionPriorities (priorityOrder model actionId targetId))
                            { model | dragged = Nothing, priorityDropTarget = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        CardKey actionId key ->
            case key of
                Character "d" ->
                    moveAction actionId ActionStatus.Done model

                ArrowDown ->
                    ( model, focusAdjacent 1 actionId model )

                ArrowUp ->
                    ( model, focusAdjacent -1 actionId model )

                _ ->
                    ( model, Cmd.none )

        Focused _ ->
            ( model, Cmd.none )

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


withConfiguration : Model -> (BoardConfiguration -> BoardConfiguration) -> BoardConfiguration
withConfiguration model change =
    change model.configuration


withDraft : Model -> (FilterDraft -> FilterDraft) -> FilterDraft
withDraft model change =
    change model.draft


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests

        optimistic =
            case pending of
                MoveAction actionId status ->
                    Dict.insert actionId status model.optimistic

                _ ->
                    model.optimistic
    in
    ( { model | requests = requests, optimistic = optimistic }
    , toHost (Host.envelope requestId (Command.encode command))
    )


{-| Moves a card straight away and lets the host correct it if the write fails.
A move to Scheduled that still needs a time opens the scheduler instead, so no
card is shown in a column its file has not reached.
-}
moveAction : ActionId -> ActionStatus -> Model -> ( Model, Cmd Msg )
moveAction actionId status model =
    case Data.findAction actionId model.snapshot.actions of
        Nothing ->
            ( model, Cmd.none )

        Just action ->
            if action.status == status then
                ( model, Cmd.none )

            else
                send
                    (if status == ActionStatus.Scheduled && Data.schedule action == Nothing then
                        IgnoreReply

                     else
                        MoveAction actionId status
                    )
                    (Command.SetActionStatus actionId status)
                    model


focusAdjacent : Int -> ActionId -> Model -> Cmd Msg
focusAdjacent offset actionId model =
    let
        ids =
            buildGroups model |> List.concatMap (.actions >> List.map .id)

        position =
            ids |> List.indexedMap Tuple.pair |> List.filter (\( _, id ) -> id == actionId) |> List.head |> Maybe.map Tuple.first
    in
    case position |> Maybe.andThen (\index -> List.drop (index + offset) ids |> List.head) of
        Just target ->
            Browser.Dom.focus (cardDomId target) |> Task.attempt Focused

        Nothing ->
            Cmd.none


saveCurrentView : Model -> ( Model, Cmd Msg )
saveCurrentView model =
    case model.activeViewId of
        Nothing ->
            promptForView False model

        Just activeId ->
            let
                settings =
                    model.snapshot.settings

                views =
                    List.map
                        (\saved ->
                            if saved.id == activeId then
                                { saved | configuration = model.configuration }

                            else
                                saved
                        )
                        settings.savedViews
            in
            case List.filter (\saved -> saved.id == activeId) views |> List.head of
                Just saved ->
                    send IgnoreReply (Command.UpsertSavedView saved False) model

                Nothing ->
                    ( model, Cmd.none )


promptForView : Bool -> Model -> ( Model, Cmd Msg )
promptForView saveAs model =
    let
        activeName =
            model.activeViewId
                |> Maybe.andThen (Settings.findSavedView model.snapshot.settings.savedViews)
                |> Maybe.map .name
    in
    send CreateSavedView
        (Command.Prompt
            { title =
                if saveAs then
                    "Save board view as"

                else
                    "Save board view"
            , placeholder =
                if saveAs then
                    Maybe.map (\name -> name ++ " copy") activeName |> Maybe.withDefault "View name"

                else
                    "View name"
            }
        )
        model


createSavedView : String -> Model -> ( Model, Cmd Msg )
createSavedView name model =
    let
        -- The seed only ever grows, so two views saved before a snapshot lands still differ.
        viewId =
            "view-" ++ String.fromInt model.snapshot.revision ++ "-" ++ String.fromInt model.savedViewSeed

        saved =
            { id = viewId, name = name, configuration = model.configuration }
    in
    send IgnoreReply
        (Command.UpsertSavedView saved True)
        { model | activeViewId = Just viewId, savedViewSeed = model.savedViewSeed + 1 }


deleteCurrentView : Model -> ( Model, Cmd Msg )
deleteCurrentView model =
    case model.activeViewId of
        Nothing ->
            ( model, Cmd.none )

        Just activeId ->
            let
                settings =
                    model.snapshot.settings
            in
            send IgnoreReply
                (Command.DeleteSavedView activeId)
                { model | activeViewId = Nothing, configuration = Settings.defaultConfiguration settings }



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            ( { model
                | snapshot = snapshot
                , optimistic = Dict.filter (\actionId status -> not (converged actionId status snapshot)) model.optimistic
                , fatalError = Nothing
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
            case ( outcome.result, Maybe.withDefault IgnoreReply pending ) of
                ( Ok resultValue, CreateSavedView ) ->
                    case Decode.decodeValue Decode.string resultValue of
                        Ok name ->
                            createSavedView name next

                        Err _ ->
                            ( next, Cmd.none )

                ( Ok _, _ ) ->
                    ( next, Cmd.none )

                ( Err message, MoveAction actionId _ ) ->
                    ( { next | optimistic = Dict.remove actionId next.optimistic, fatalError = Just message }, Cmd.none )

                ( Err message, _ ) ->
                    ( { next | fatalError = Just message }, Cmd.none )

        Err error ->
            ( { model | fatalError = Just (Decode.errorToString error) }, Cmd.none )


{-| True once the vault agrees with a move the board already drew.
-}
converged : ActionId -> ActionStatus -> Snapshot -> Bool
converged actionId status snapshot =
    Data.findAction actionId snapshot.actions
        |> Maybe.map (\action -> action.status == status)
        |> Maybe.withDefault True



-- VIEW


view : Model -> Html Msg
view model =
    case model.fatalError of
        Just error ->
            div [ class "dg-view dg-board-view" ]
                [ div [ class "dg-warning" ] [ text ("Elm adapter error: " ++ error) ]
                , boardView model
                ]

        Nothing ->
            boardView model


boardView : Model -> Html Msg
boardView model =
    let
        groups =
            buildGroups model

        -- The count describes the cards on screen, not every Action in the vault.
        shown =
            groups |> List.map (.actions >> List.length) |> List.sum
    in
    div [ class "dg-view dg-board-view" ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 [] [ text "Actions" ]
                , span
                    [ class "dg-count"
                    , title (String.fromInt shown ++ " shown of " ++ Ui.plural (List.length model.snapshot.actions) "Action")
                    ]
                    [ text (String.fromInt shown) ]
                ]
            , div [ class "dg-header-actions" ]
                [ button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewActionModal Nothing)) ] [ text "New Action" ]
                , button [ onClick (Send IgnoreReply Command.QuickCapture) ] [ text "Quick Capture" ]
                , button [ onClick (Send IgnoreReply Command.OpenInbox) ] [ text "Open Inbox" ]
                ]
            ]
        , Ui.issuesView model.snapshot.issues
        , toolbar model
        , if model.filterOpen then
            filterBuilder model

          else
            text ""
        , if model.columnsOpen then
            columnPicker model

          else
            text ""
        , filterChips model
        , div [ class "dg-board", attribute "role" "list" ]
            (if List.isEmpty groups then
                [ div [ class "dg-empty" ] [ text "No Actions match this view." ] ]

             else
                List.map (groupView model) groups
            )
        ]


toolbar : Model -> Html Msg
toolbar model =
    div [ class "dg-toolbar" ]
        [ select [ attribute "aria-label" "Saved view", onInput SelectSavedView ]
            (option [ value "", selected (model.activeViewId == Nothing) ] [ text "Board" ]
                :: List.map
                    (\saved -> option [ value saved.id, selected (model.activeViewId == Just saved.id) ] [ text saved.name ])
                    model.snapshot.settings.savedViews
            )
        , input [ type_ "search", placeholder "Search Actions or Projects", value model.search, onInput SearchChanged ] []
        , label [ class "dg-toolbar-toggle", title "Also show Actions of Backlog, Someday/Maybe, Completed and Cancelled Projects" ]
            [ input [ type_ "checkbox", checked model.allProjects, onCheck ToggleAllProjects ] [], span [] [ text "All projects" ] ]
        , button [ classList [ ( "is-active", model.filterOpen ) ], onClick ToggleFilters ] [ text "Filter" ]
        , choices [ attribute "aria-label" "Group by" ]
            groupByKey
            SetGroupBy
            model.configuration.groupBy
            (List.map (\groupBy -> ( groupBy, "Group: " ++ Settings.groupByLabel groupBy ))
                [ GroupByStatus, GroupByProject, GroupByContext, GroupByEnergy ]
            )
        , choices [ attribute "aria-label" "Sort by" ]
            sortFieldKey
            SetSortField
            model.configuration.sort.field
            (List.map (\field -> ( field, "Sort: " ++ Settings.sortFieldLabel field ))
                [ SortByCreated, SortByDue, SortByTitle, SortByProject ]
            )
        , button [ attribute "aria-label" "Reverse sort", onClick ReverseSort ]
            [ text
                (case model.configuration.sort.direction of
                    Ascending ->
                        "↑"

                    Descending ->
                        "↓"
                )
            ]
        , button [ classList [ ( "is-active", model.columnsOpen ) ], onClick ToggleColumns ] [ text "Columns" ]
        , button [ onClick SaveView ] [ text "Save" ]
        , button [ onClick SaveViewAs ] [ text "Save As" ]
        , if model.activeViewId /= Nothing then
            button [ attribute "aria-label" "Delete saved view", onClick DeleteView ] [ text "Delete" ]

          else
            text ""
        ]


{-| A `select` over a union: the options are the union's values, and a choice can
only ever be one of them.
-}
choices : List (Html.Attribute msg) -> (a -> String) -> (a -> msg) -> a -> List ( a, String ) -> Html msg
choices attributes toKey toMessage current options =
    select
        (value (toKey current)
            :: onInput (\raw -> List.filter (\( candidate, _ ) -> toKey candidate == raw) options |> List.head |> Maybe.map (Tuple.first >> toMessage) |> Maybe.withDefault (toMessage current))
            :: attributes
        )
        (List.map (\( candidate, label ) -> option [ value (toKey candidate) ] [ text label ]) options)


filterBuilder : Model -> Html Msg
filterBuilder model =
    let
        draft =
            model.draft
    in
    div [ class "dg-panel dg-filter-builder" ]
        [ choices []
            filterFieldKey
            SetFilterField
            draft.field
            [ ( FieldStatus, "Status" )
            , ( FieldProject, "Project" )
            , ( FieldContext, "Context" )
            , ( FieldEnergy, "Energy" )
            , ( FieldDue, "Due date" )
            , ( FieldAvailable, "Available now" )
            , ( FieldWork, "Work" )
            ]
        , if List.member draft.field [ FieldDue, FieldAvailable ] then
            text ""

          else
            choices [] operatorKey SetFilterOperator draft.operator [ ( Is, "is" ), ( IsNot, "is not" ) ]
        , if List.member draft.field [ FieldDue, FieldAvailable, FieldWork ] then
            text ""

          else
            select [ value draft.value, onInput SetFilterValue ]
                (List.map (\( key, name ) -> option [ value key ] [ text name ]) (filterValues model))
        , if draft.field == FieldDue then
            dueControls model

          else
            text ""
        , button [ class "mod-cta", onClick AddFilter ] [ text "Add filter" ]
        ]


dueControls : Model -> Html Msg
dueControls model =
    span []
        [ choices []
            dueOperatorKey
            SetDueOperator
            model.draft.dueOperator
            [ ( OpBefore, "before" )
            , ( OpOnOrBefore, "on or before" )
            , ( OpAfter, "after" )
            , ( OpOnOrAfter, "on or after" )
            , ( OpWithinNextDays, "within next days" )
            , ( OpIsEmpty, "is empty" )
            , ( OpIsNotEmpty, "is not empty" )
            ]
        , if List.member model.draft.dueOperator [ OpIsEmpty, OpIsNotEmpty ] then
            text ""

          else
            input
                [ type_
                    (if model.draft.dueOperator == OpWithinNextDays then
                        "number"

                     else
                        "date"
                    )
                , value model.draft.dueValue
                , onInput SetDueValue
                ]
                []
        ]


filterChips : Model -> Html Msg
filterChips model =
    if List.isEmpty model.configuration.filters then
        text ""

    else
        div [ class "dg-filter-chips" ]
            (List.indexedMap
                (\index filter -> button [ class "dg-chip", onClick (RemoveFilter index) ] [ text (describeFilter model filter ++ " ×") ])
                model.configuration.filters
            )


columnPicker : Model -> Html Msg
columnPicker model =
    let
        candidates =
            columnCandidates model

        visible =
            case model.configuration.visibleColumns of
                AllColumns ->
                    List.map groupKeyString candidates

                OnlyColumns columns ->
                    columns
    in
    div [ class "dg-panel dg-column-picker" ]
        (List.map
            (\key ->
                label []
                    [ input
                        [ type_ "checkbox"
                        , checked (List.member (groupKeyString key) visible)
                        , onCheck (\_ -> ToggleColumn key)
                        ]
                        []
                    , text (" " ++ groupLabel model key)
                    ]
            )
            candidates
        )


groupView : Model -> Group -> Html Msg
groupView model group =
    let
        dropAttributes =
            case ( model.configuration.groupBy, group.key ) of
                ( GroupByStatus, StatusGroup status ) ->
                    if status == ActionStatus.Cancelled then
                        []

                    else
                        [ Ui.preventDefaultOn "dragover" DragOver, Ui.preventDefaultOn "drop" (DropOn status) ]

                _ ->
                    []
    in
    section
        (class "dg-column" :: attribute "data-column" (groupKeyString group.key) :: dropAttributes)
        [ header [ class "dg-column-header" ]
            [ span [] [ text (groupLabel model group.key) ]
            , span [] [ text (String.fromInt (List.length group.actions)) ]
            ]
        , div [ class "dg-card-list" ] (List.map (cardView model) group.actions)
        ]


cardView : Model -> Action -> Html Msg
cardView model action =
    let
        breadcrumb =
            action.projectId |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)

        overdue =
            Maybe.map (\due -> due < model.snapshot.today && action.status /= ActionStatus.Done) action.due
                |> Maybe.withDefault False
    in
    article
        [ classList
            [ ( "dg-card", True )
            , ( "is-drop-before", model.priorityDropTarget == Just action.id )
            ]
        , attribute "role" "listitem"
        , attribute "data-card" action.id
        , id (cardDomId action.id)
        , tabindex 0
        , draggable "true"
        , on "dragstart" (Decode.succeed (DragStarted action.id))
        , on "dragend" (Decode.succeed DragEnded)
        , custom "dragover" (Decode.succeed { message = DragOverCard action.id, stopPropagation = True, preventDefault = True })
        , custom "drop" (Decode.succeed { message = DropBefore action.id, stopPropagation = True, preventDefault = True })
        , Ui.onKeyDown (CardKey action.id)
        ]
        [ div [ class "dg-card-title-row" ]
            [ span [ class "dg-card-title dg-action-card-title", title action.title ] [ text action.title ]
            , button
                [ class "dg-icon-button dg-flat-button"
                , attribute "aria-label" ("Actions for " ++ action.title)
                , Ui.onPointer (\x y -> Send IgnoreReply (actionMenu x y model action))
                ]
                [ text "•••" ]
            ]
        , case ( action.projectId, breadcrumb ) of
            ( Just projectId, Just name ) ->
                let
                    labelled =
                        withStatusSymbol model projectId name
                in
                button [ class "dg-project-link dg-flat-button", title labelled, onClick (Send IgnoreReply (Command.ShowProject projectId)) ] [ text labelled ]

            ( Just _, Nothing ) ->
                span [ class "dg-missing" ] [ text "Missing project" ]

            ( Nothing, _ ) ->
                text ""
        , div [ class "dg-card-meta" ]
            [ Ui.maybeView (Maybe.map (\context -> "@" ++ context) action.context) (\shown -> span [] [ text shown ])
            , Ui.maybeView action.energy (\energy -> span [] [ text energy ])
            , Ui.maybeView action.due (\due -> span [ classList [ ( "is-overdue", overdue ) ] ] [ text due ])
            , if action.status == ActionStatus.Waiting then
                span [] [ text ("Waiting since " ++ Maybe.withDefault "—" action.waitingSince) ]

              else
                text ""
            , Ui.maybeView (Data.scheduleText action) (\schedule -> span [] [ text schedule ])
            ]
        ]


cardDomId : ActionId -> String
cardDomId actionId =
    "dg-action-" ++ actionId



-- GROUPING


buildGroups : Model -> List Group
buildGroups model =
    let
        actions =
            model.snapshot.actions
                |> List.map (\action -> { action | status = Dict.get action.id model.optimistic |> Maybe.withDefault action.status })
                |> List.filter (matchesAll model)
                |> sortActions model

        grouped =
            List.foldl
                (\action buckets ->
                    let
                        key =
                            groupKeyOf model.configuration.groupBy action
                    in
                    Dict.update (groupKeyString key)
                        (\existing ->
                            Just ( key, action :: (Maybe.map Tuple.second existing |> Maybe.withDefault []) )
                        )
                        buckets
                )
                Dict.empty
                actions

        keys =
            case model.configuration.groupBy of
                GroupByStatus ->
                    statusColumnKeys model |> List.map StatusGroup

                _ ->
                    Dict.values grouped
                        |> List.map Tuple.first
                        |> applyVisible model.configuration.visibleColumns
    in
    List.map
        (\key ->
            { key = key
            , actions = Dict.get (groupKeyString key) grouped |> Maybe.map (Tuple.second >> List.reverse) |> Maybe.withDefault []
            }
        )
        keys


{-| The status columns a status-grouped board lays out: the saved choice when the
view has one, and otherwise every status the settings put on the board.
-}
statusColumnKeys : Model -> List ActionStatus
statusColumnKeys model =
    case model.configuration.visibleColumns of
        AllColumns ->
            Settings.statusColumns model.snapshot.settings

        OnlyColumns columns ->
            List.filterMap statusFromKey columns


statusFromKey : String -> Maybe ActionStatus
statusFromKey raw =
    List.filter (\status -> ActionStatus.key status == raw) ActionStatus.all |> List.head


applyVisible : VisibleColumns -> List GroupKey -> List GroupKey
applyVisible visible keys =
    case visible of
        AllColumns ->
            keys

        OnlyColumns allowed ->
            List.filter (\key -> List.member (groupKeyString key) allowed) keys


groupKeyOf : GroupBy -> Action -> GroupKey
groupKeyOf groupBy action =
    case groupBy of
        GroupByStatus ->
            StatusGroup action.status

        GroupByProject ->
            ProjectGroup action.projectId

        GroupByContext ->
            ContextGroup action.context

        GroupByEnergy ->
            EnergyGroup action.energy


{-| The key a column is stored under, in the group buckets and in a saved view.
-}
groupKeyString : GroupKey -> String
groupKeyString key =
    case key of
        StatusGroup status ->
            ActionStatus.key status

        ProjectGroup projectId ->
            Maybe.withDefault "" projectId

        ContextGroup context ->
            Maybe.withDefault "" context

        EnergyGroup energy ->
            Maybe.withDefault "" energy


groupLabel : Model -> GroupKey -> String
groupLabel model key =
    case key of
        StatusGroup status ->
            ActionStatus.label status

        ProjectGroup Nothing ->
            "No project"

        ProjectGroup (Just projectId) ->
            Hierarchy.breadcrumbFor model.snapshot.projects projectId
                |> Maybe.map (withStatusSymbol model projectId)
                |> Maybe.withDefault "Missing project"

        ContextGroup Nothing ->
            "No context"

        ContextGroup (Just context) ->
            capitalized context

        EnergyGroup Nothing ->
            "No energy"

        EnergyGroup (Just energy) ->
            capitalized energy


{-| Prefixes a Project name with a symbol for its status, so Actions of a Project
that is not Active stand out once the board shows every Project.
-}
withStatusSymbol : Model -> ProjectId -> String -> String
withStatusSymbol model projectId name =
    case Data.findProject projectId model.snapshot.projects |> Maybe.andThen (.status >> statusSymbol) of
        Just symbol ->
            symbol ++ " " ++ name

        Nothing ->
            name


statusSymbol : ProjectStatus -> Maybe String
statusSymbol status =
    case status of
        ProjectStatus.Active ->
            Nothing

        ProjectStatus.Backlog ->
            Just "⏸"

        ProjectStatus.Someday ->
            Just "☁"

        ProjectStatus.Completed ->
            Just "✓"

        ProjectStatus.Cancelled ->
            Just "✕"


capitalized : String -> String
capitalized value =
    String.toUpper (String.left 1 value) ++ String.dropLeft 1 value


columnCandidates : Model -> List GroupKey
columnCandidates model =
    case model.configuration.groupBy of
        GroupByStatus ->
            Settings.statusColumns model.snapshot.settings |> List.map StatusGroup

        _ ->
            let
                config =
                    model.configuration
            in
            buildGroups { model | configuration = { config | visibleColumns = AllColumns } } |> List.map .key



-- FILTERING


matchesAll : Model -> Action -> Bool
matchesAll model action =
    let
        projectText =
            action.projectId
                |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)
                |> Maybe.withDefault ""
    in
    (model.allProjects || belongsToActiveProject model action)
        && Ui.matches model.search [ action.title, projectText ]
        && List.all (matchesFilter model action) model.configuration.filters


{-| The Actions Board is for current project work. An Action without a Project
remains a valid standalone Action; an Action whose referenced Project is missing
is not surfaced as active work.
-}
belongsToActiveProject : Model -> Action -> Bool
belongsToActiveProject model action =
    case action.projectId of
        Nothing ->
            True

        Just projectId ->
            Data.findProject projectId model.snapshot.projects
                |> Maybe.map (\project -> project.status == ProjectStatus.Active)
                |> Maybe.withDefault False


matchesFilter : Model -> Action -> Filter -> Bool
matchesFilter model action filter =
    case filter of
        ByStatus operator values ->
            applyOperator operator (List.member action.status values)

        ByProject operator values ->
            applyOperator operator (List.member action.projectId values)

        ByContext operator values ->
            applyOperator operator (List.member (Maybe.withDefault "" action.context) values)

        ByEnergy operator values ->
            applyOperator operator (List.member (Maybe.withDefault "" action.energy) values)

        ByAvailability ->
            Maybe.map (\date -> date <= model.snapshot.today) action.deferUntil |> Maybe.withDefault True

        ByWork expected ->
            action.work == expected

        ByDue range ->
            matchesDue model range action.due


applyOperator : MatchOperator -> Bool -> Bool
applyOperator operator contains =
    case operator of
        Is ->
            contains

        IsNot ->
            not contains


matchesDue : Model -> DueRange -> Maybe String -> Bool
matchesDue model range maybeDue =
    case ( range, maybeDue ) of
        ( DueIsEmpty, Nothing ) ->
            True

        ( DueIsNotEmpty, Just _ ) ->
            True

        ( DueBefore expected, Just due ) ->
            due < expected

        ( DueOnOrBefore expected, Just due ) ->
            due <= expected

        ( DueAfter expected, Just due ) ->
            due > expected

        ( DueOnOrAfter expected, Just due ) ->
            due >= expected

        ( DueWithinDays days, Just due ) ->
            due >= model.snapshot.today && due <= addDays model.snapshot.today days

        _ ->
            False


sortActions : Model -> List Action -> List Action
sortActions model actions =
    let
        key action =
            case model.configuration.sort.field of
                SortByDue ->
                    Maybe.withDefault "9999-99-99" action.due

                SortByTitle ->
                    String.toLower action.title

                SortByProject ->
                    action.projectId
                        |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)
                        |> Maybe.map String.toLower
                        |> Maybe.withDefault "zzzz"

                SortByCreated ->
                    action.created

        descending =
            model.configuration.sort.direction == Descending

        compareActions left right =
            case comparePriority left right of
                EQ ->
                    compareByConfiguredSort left right

                priorityComparison ->
                    priorityComparison

        compareByConfiguredSort left right =
            if model.configuration.sort.field == SortByDue then
                -- An Action with no due date sorts last in both directions.
                case ( left.due, right.due ) of
                    ( Nothing, Nothing ) ->
                        compare left.id right.id

                    ( Nothing, Just _ ) ->
                        GT

                    ( Just _, Nothing ) ->
                        LT

                    ( Just leftDue, Just rightDue ) ->
                        if descending then
                            compare ( rightDue, right.id ) ( leftDue, left.id )

                        else
                            compare ( leftDue, left.id ) ( rightDue, right.id )

            else if descending then
                compare ( key right, right.id ) ( key left, left.id )

            else
                compare ( key left, left.id ) ( key right, right.id )
    in
    List.sortWith compareActions actions


{-| A manually ranked Action always comes before an unranked one. The selected
sort remains the stable fallback until an Action receives a priority.
-}
comparePriority : Action -> Action -> Order
comparePriority left right =
    case ( left.priority, right.priority ) of
        ( Just leftPriority, Just rightPriority ) ->
            compare ( leftPriority, left.id ) ( rightPriority, right.id )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        ( Nothing, Nothing ) ->
            EQ


{-| Preserve the order visible on the board, then append anything currently
outside its filters so one dropped card establishes a complete global ranking.
-}
priorityOrder : Model -> ActionId -> ActionId -> List ActionId
priorityOrder model actionId targetId =
    let
        visible =
            buildGroups model |> List.concatMap (.actions >> List.map .id)

        moved =
            insertBefore actionId targetId visible

        remaining =
            model.snapshot.actions
                |> List.map (\action -> { action | status = Dict.get action.id model.optimistic |> Maybe.withDefault action.status })
                |> List.filter (\action -> not (List.member action.id moved))
                |> sortActions model
                |> List.map .id
    in
    moved ++ remaining


insertBefore : ActionId -> ActionId -> List ActionId -> List ActionId
insertBefore actionId targetId actionIds =
    let
        withoutDragged =
            List.filter ((/=) actionId) actionIds
    in
    List.foldr
        (\candidate result ->
            if candidate == targetId then
                actionId :: candidate :: result

            else
                candidate :: result
        )
        []
        withoutDragged


{-| The options a value filter offers for the field the draft names.
-}
filterValues : Model -> List ( String, String )
filterValues model =
    case model.draft.field of
        FieldStatus ->
            List.map (\status -> ( ActionStatus.key status, ActionStatus.label status )) ActionStatus.all

        FieldProject ->
            ( "", "No project" )
                :: (model.snapshot.projects
                        |> List.map (\project -> ( project.id, Hierarchy.breadcrumb model.snapshot.projects project ))
                        |> List.sortBy Tuple.second
                   )

        FieldContext ->
            Data.contexts model.snapshot.actions |> List.map (\item -> ( item, item ))

        FieldEnergy ->
            Data.energies model.snapshot.actions |> List.map (\item -> ( item, item ))

        _ ->
            []


{-| The filter the builder would add, or nothing when its value never resolved.
-}
draftFilter : Model -> Maybe Filter
draftFilter model =
    let
        draft =
            model.draft
    in
    case draft.field of
        FieldAvailable ->
            Just ByAvailability

        FieldWork ->
            Just (ByWork (draft.operator == Is))

        FieldDue ->
            Just (ByDue (dueRange draft))

        FieldStatus ->
            statusFromKey draft.value |> Maybe.map (\status -> ByStatus draft.operator [ status ])

        FieldProject ->
            Just
                (ByProject draft.operator
                    [ if String.isEmpty draft.value then
                        Nothing

                      else
                        Just draft.value
                    ]
                )

        FieldContext ->
            Just (ByContext draft.operator [ draft.value ])

        FieldEnergy ->
            Just (ByEnergy draft.operator [ draft.value ])


dueRange : FilterDraft -> DueRange
dueRange draft =
    case draft.dueOperator of
        OpBefore ->
            DueBefore draft.dueValue

        OpOnOrBefore ->
            DueOnOrBefore draft.dueValue

        OpAfter ->
            DueAfter draft.dueValue

        OpOnOrAfter ->
            DueOnOrAfter draft.dueValue

        OpWithinNextDays ->
            DueWithinDays (String.toInt draft.dueValue |> Maybe.withDefault 7)

        OpIsEmpty ->
            DueIsEmpty

        OpIsNotEmpty ->
            DueIsNotEmpty


describeFilter : Model -> Filter -> String
describeFilter model filter =
    case filter of
        ByAvailability ->
            "Available now"

        ByWork True ->
            "Work"

        ByWork False ->
            "Not work"

        ByDue range ->
            describeDue range

        ByStatus operator values ->
            described "Status" operator (List.map ActionStatus.label values)

        ByProject operator values ->
            described "Project"
                operator
                (List.map
                    (\maybeId ->
                        case maybeId of
                            Nothing ->
                                "No project"

                            Just projectId ->
                                Hierarchy.breadcrumbFor model.snapshot.projects projectId |> Maybe.withDefault "Missing project"
                    )
                    values
                )

        ByContext operator values ->
            described "Context" operator values

        ByEnergy operator values ->
            described "Energy" operator values


described : String -> MatchOperator -> List String -> String
described field operator names =
    field
        ++ (case operator of
                Is ->
                    " is "

                IsNot ->
                    " is not "
           )
        ++ String.join ", " names


describeDue : DueRange -> String
describeDue range =
    case range of
        DueBefore date ->
            "Due before " ++ date

        DueOnOrBefore date ->
            "Due on or before " ++ date

        DueAfter date ->
            "Due after " ++ date

        DueOnOrAfter date ->
            "Due on or after " ++ date

        DueWithinDays days ->
            "Due within " ++ String.fromInt days ++ " days"

        DueIsEmpty ->
            "Due is empty"

        DueIsNotEmpty ->
            "Due is not empty"



-- MENU


actionMenu : Float -> Float -> Model -> Action -> Command
actionMenu x y model action =
    let
        statusEntries =
            List.map
                (\status -> MenuItem (tick (status == action.status) ++ ActionStatus.label status) (Command.SetActionStatus action.id status))
                ActionStatus.all

        projects =
            model.snapshot.projects
                |> List.filter (\project -> ProjectStatus.isOpen project.status)
                |> List.sortBy (Hierarchy.breadcrumb model.snapshot.projects)

        projectEntries =
            MenuItem "No project" (Command.SetActionProject action.id Nothing)
                :: List.map
                    (\project ->
                        MenuItem
                            (tick (action.projectId == Just project.id) ++ Hierarchy.breadcrumb model.snapshot.projects project)
                            (Command.SetActionProject action.id (Just project.id))
                    )
                    projects

        contexts =
            Data.contexts model.snapshot.actions

        contextEntries =
            List.map
                (\context ->
                    MenuItem (tick (action.context == Just context) ++ "@" ++ context) (Command.SetActionContext action.id context)
                )
                contexts
    in
    Command.ShowMenu x
        y
        (statusEntries
            ++ (MenuSeparator :: projectEntries)
            ++ (if List.isEmpty contexts then
                    []

                else
                    MenuSeparator :: contextEntries
               )
            ++ [ MenuSeparator
               , MenuItem "Edit…" (Command.EditActionModal action.id)
               , MenuItem "Delete Action…" (Command.TrashAction action.id)
               ]
        )


tick : Bool -> String
tick marked =
    if marked then
        "✓ "

    else
        ""



-- KEYS FOR SELECT CONTROLS


groupByKey : GroupBy -> String
groupByKey groupBy =
    case groupBy of
        GroupByStatus ->
            "status"

        GroupByProject ->
            "project"

        GroupByContext ->
            "context"

        GroupByEnergy ->
            "energy"


sortFieldKey : SortField -> String
sortFieldKey field =
    case field of
        SortByCreated ->
            "created"

        SortByDue ->
            "due"

        SortByTitle ->
            "title"

        SortByProject ->
            "project"


operatorKey : MatchOperator -> String
operatorKey operator =
    case operator of
        Is ->
            "in"

        IsNot ->
            "notIn"


filterFieldKey : FilterField -> String
filterFieldKey field =
    case field of
        FieldStatus ->
            "status"

        FieldProject ->
            "project"

        FieldContext ->
            "context"

        FieldEnergy ->
            "energy"

        FieldDue ->
            "due"

        FieldAvailable ->
            "available"

        FieldWork ->
            "work"


dueOperatorKey : DueOperator -> String
dueOperatorKey operator =
    case operator of
        OpBefore ->
            "before"

        OpOnOrBefore ->
            "onOrBefore"

        OpAfter ->
            "after"

        OpOnOrAfter ->
            "onOrAfter"

        OpWithinNextDays ->
            "withinNextDays"

        OpIsEmpty ->
            "isEmpty"

        OpIsNotEmpty ->
            "isNotEmpty"



-- HELPERS


removeAt : Int -> List a -> List a
removeAt index values =
    List.indexedMap Tuple.pair values |> List.filter (\( candidate, _ ) -> candidate /= index) |> List.map Tuple.second


{-| Calendar arithmetic on `yyyy-mm-dd`, through the day number of the proleptic
Gregorian calendar.
-}
addDays : String -> Int -> String
addDays date amount =
    case String.split "-" date |> List.filterMap String.toInt of
        [ year, month, day ] ->
            dateFromOrdinal (ordinal year month day + amount)

        _ ->
            date


ordinal : Int -> Int -> Int -> Int
ordinal year month day =
    let
        adjustedYear =
            if month <= 2 then
                year - 1

            else
                year

        adjustedMonth =
            if month <= 2 then
                month + 12

            else
                month
    in
    365 * adjustedYear + adjustedYear // 4 - adjustedYear // 100 + adjustedYear // 400 + (153 * (adjustedMonth - 3) + 2) // 5 + day - 1


dateFromOrdinal : Int -> String
dateFromOrdinal value =
    let
        era =
            value // 146097

        dayOfEra =
            value - era * 146097

        yearOfEra =
            (dayOfEra - dayOfEra // 1460 + dayOfEra // 36524 - dayOfEra // 146096) // 365

        rawYear =
            yearOfEra + era * 400

        dayOfYear =
            dayOfEra - (365 * yearOfEra + yearOfEra // 4 - yearOfEra // 100)

        monthPrime =
            (5 * dayOfYear + 2) // 153

        day =
            dayOfYear - (153 * monthPrime + 2) // 5 + 1

        month =
            monthPrime
                + (if monthPrime < 10 then
                    3

                   else
                    -9
                  )

        year =
            rawYear
                + (if month <= 2 then
                    1

                   else
                    0
                  )

        pad number =
            String.padLeft 2 '0' (String.fromInt number)
    in
    String.fromInt year ++ "-" ++ pad month ++ "-" ++ pad day



-- DECODING


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
